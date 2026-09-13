/**
 * Optional SSH-tunnel connector, loaded via dynamic import only when PG_SSH_HOST is set, so a direct
 * connection pulls neither this module nor its `ssh2` optional dependency. One Tunnel owns the SSH
 * client, listener, sockets, failure tracking, and cleanup.
 *
 *   pg.Client -> 127.0.0.1 listener -> ssh2 forwardOut -> SSH bastion -> PostgreSQL
 */
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { resolveClientOptions, type Connection, type Connector, type ServerConfig, type SshConfig } from './index.js';
import { ConnectionError } from './errors.js';
import type { ConnectConfig } from 'ssh2';

// Structural slice of ssh2's Client, so tests inject a fake and ssh2 stays a lazy runtime import.
export interface SshClientLike {
  forwardOut(srcHost: string, srcPort: number, dstHost: string, dstPort: number, cb: (err: Error | undefined, channel: Duplex) => void): void;
  end(): void;
  destroy(): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

// Injectable boundaries (real ssh2 + pg by default) so tests drive the connector without a bastion.
export interface SshConnectorDeps {
  openSsh(config: ConnectConfig): Promise<SshClientLike>;
  createPgClient(options: pg.ClientConfig): pg.Client;
  validateKey(key: string | Buffer, passphrase?: string | Buffer): Promise<Error | undefined>;
}

const defaultDeps: SshConnectorDeps = {
  async validateKey(key, passphrase) {
    const mod = await import('ssh2'); // CJS: utils lives under the default export via ESM interop
    const utils = mod.utils ?? mod.default.utils;
    const parsed = utils.parseKey(key, passphrase);
    if (parsed instanceof Error) return parsed;
    const one = Array.isArray(parsed) ? parsed[0] : parsed;
    if (one === undefined || !one.isPrivateKey()) return new Error('not a usable private key (a public key is not enough)');
    return undefined;
  },
  async openSsh(config) {
    const { Client } = await import('ssh2');
    const client = new Client();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        client.removeListener('ready', onReady);
        client.removeListener('error', onFail);
        client.removeListener('close', onClose);
        client.removeListener('end', onClose);
      };
      const succeed = (): void => { if (settled) return; settled = true; cleanup(); resolve(); };
      const failWith = (err: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        try { client.end(); } catch { /* releasing a half-open client */ }
        reject(err);
      };
      const onReady = (): void => succeed();
      const onFail = (err: unknown): void => failWith(err instanceof Error ? err : new Error(String(err)));
      // ssh2's readyTimeout (from connectTimeoutMs) emits an 'error' if the handshake stalls, so no
      // extra timer is needed; a premature close/end still settles as a failure.
      const onClose = (): void => failWith(new Error('SSH connection closed before it became ready'));
      client.once('ready', onReady);
      client.once('error', onFail);
      client.once('close', onClose);
      client.once('end', onClose);
      client.connect(config);
    });
    return client as unknown as SshClientLike;
  },
  createPgClient: (options) => new pg.Client(options),
};

// --- configuration - auth resolution, key validation, host verification ---

// A normalized SHA256 fingerprint is exactly 43 base64 chars (32-byte digest, padding stripped).
const SHA256_FINGERPRINT = /^[A-Za-z0-9+/]{43}$/;
const FINGERPRINT_HINT = 'get it with ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub (on the bastion) or ssh-keygen -lF host (from ~/.ssh/known_hosts)';

// Fail-closed: a pinned, well-formed fingerprint is required, else refuse rather than trust any key.
// A malformed value is SSH_CONFIG_INVALID here, not an ambiguous mismatch later.
export function buildHostVerifier(sshConfig: SshConfig): (key: Buffer) => boolean {
  if (sshConfig.fingerprint === undefined) {
    throw new ConnectionError('SSH_CONFIG_INVALID', 'SSH host-key verification is required: set PG_SSH_FINGERPRINT', { hint: FINGERPRINT_HINT });
  }
  const want = normalizeFingerprint(sshConfig.fingerprint);
  if (!SHA256_FINGERPRINT.test(want)) {
    throw new ConnectionError('SSH_CONFIG_INVALID', `PG_SSH_FINGERPRINT is not a valid SHA256 fingerprint (expected "SHA256:" + 43 base64 chars): '${sshConfig.fingerprint}'`, { hint: FINGERPRINT_HINT });
  }
  return (key) => normalizeFingerprint(createHash('sha256').update(key).digest('base64')) === want;
}

function normalizeFingerprint(fp: string): string {
  return fp.replace(/^SHA256:/i, '').replace(/=+$/, '');
}

// First of id_ed25519 / id_rsa / id_ecdsa under $HOME (or %USERPROFILE% on Windows).
export function defaultKeyPath(env: NodeJS.ProcessEnv): string | undefined {
  const home = env.HOME ?? env.USERPROFILE;
  if (home === undefined || home === '') return undefined;
  for (const name of ['id_ed25519', 'id_rsa', 'id_ecdsa']) {
    const path = join(home, '.ssh', name);
    if (existsSync(path)) return path;
  }
  return undefined;
}

// Auth resolves like ssh: explicit key/agent/password, else a running agent, then a default key.
// onHostKeyMismatch fires on a fingerprint mismatch so it is reported distinctly from a handshake failure.
export function buildSshConnectConfig(sshConfig: SshConfig, connectTimeoutMs: number, env: NodeJS.ProcessEnv = process.env, onHostKeyMismatch?: () => void): ConnectConfig {
  const verify = buildHostVerifier(sshConfig);
  const config: ConnectConfig = {
    host: sshConfig.host,
    port: sshConfig.port,
    username: sshConfig.user,
    readyTimeout: connectTimeoutMs,
    keepaliveInterval: sshConfig.keepaliveIntervalMs,
    keepaliveCountMax: 3,
    hostVerifier: onHostKeyMismatch === undefined
      ? verify
      : (key: Buffer) => { const ok = verify(key); if (!ok) onHostKeyMismatch(); return ok; },
  };
  const useKey = (path: string): void => {
    try {
      config.privateKey = readFileSync(path);
    } catch (err) {
      throw new ConnectionError('SSH_KEY_INVALID', `cannot read SSH private key '${path}'`, { hint: 'check PG_SSH_PRIVATE_KEY points to a readable key file', cause: err });
    }
    if (sshConfig.passphrase !== undefined) config.passphrase = sshConfig.passphrase;
  };
  if (sshConfig.privateKeyPath !== undefined) {
    useKey(sshConfig.privateKeyPath);
  } else if (sshConfig.agent !== undefined) {
    const agent = sshConfig.agent === 'true' ? env.SSH_AUTH_SOCK : sshConfig.agent; // 'true' = ambient agent
    if (agent === undefined || agent === '') {
      throw new ConnectionError('SSH_CONFIG_INVALID', 'PG_SSH_AGENT=true but SSH_AUTH_SOCK is not set', { hint: 'set SSH_AUTH_SOCK to a running agent, or give PG_SSH_PRIVATE_KEY / PG_SSH_PASSWORD' });
    }
    config.agent = agent;
  } else if (sshConfig.password !== undefined) {
    config.password = sshConfig.password;
  } else if (env.SSH_AUTH_SOCK !== undefined && env.SSH_AUTH_SOCK !== '') {
    config.agent = env.SSH_AUTH_SOCK;
  } else {
    const keyPath = defaultKeyPath(env);
    if (keyPath === undefined) {
      throw new ConnectionError('SSH_CONFIG_INVALID', 'SSH authentication required: set PG_SSH_PRIVATE_KEY, PG_SSH_AGENT, or PG_SSH_PASSWORD, or provide a default key (~/.ssh/id_ed25519) or a running agent (SSH_AUTH_SOCK)', { hint: 'set one of PG_SSH_PRIVATE_KEY / PG_SSH_AGENT / PG_SSH_PASSWORD' });
    }
    useKey(keyPath);
  }
  return config;
}

type SshAuthMethod = 'key' | 'agent' | 'password';

// Reads the resolved config so buildSshConnectConfig stays the single source for auth precedence.
function authMethodOf(config: ConnectConfig): SshAuthMethod {
  if (config.privateKey !== undefined) return 'key';
  if (config.agent !== undefined) return 'agent';
  return 'password';
}

// Reject an unusable key before opening anything, so it is SSH_KEY_INVALID, not a handshake failure.
async function ensureValidKey(config: ConnectConfig, deps: SshConnectorDeps): Promise<void> {
  if (config.privateKey === undefined) return;
  const keyErr = await deps.validateKey(config.privateKey, config.passphrase);
  if (keyErr !== undefined) {
    throw new ConnectionError('SSH_KEY_INVALID', `SSH private key could not be used: ${keyErr.message}`, { hint: 'the key is encrypted, malformed, or a public key: set PG_SSH_PASSPHRASE or provide a valid private key in PG_SSH_PRIVATE_KEY', cause: keyErr });
  }
}

// Keep the ORIGINAL database hostname for SNI/cert validation, though the socket connects to 127.0.0.1,
// else verify-full breaks through the loopback.
export function sslForTunnel(ssl: pg.ClientConfig['ssl'], realHost: string): { ssl?: pg.ClientConfig['ssl'] } {
  if (ssl === undefined) return {};
  if (typeof ssl === 'object') return { ssl: { ...ssl, servername: realHost } };
  return { ssl };
}

// --- diagnostics - classify SSH failures into stable errors by structured ssh2 fields ---

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE']);

function sshAuthHint(method: SshAuthMethod): string {
  switch (method) {
    case 'key':
      return 'check PG_SSH_USER and the private key (PG_SSH_PRIVATE_KEY / PG_SSH_PASSPHRASE), and that it is authorized on the bastion';
    case 'agent':
      return 'check PG_SSH_USER and that the SSH agent (SSH_AUTH_SOCK / PG_SSH_AGENT) holds a key authorized on the bastion';
    case 'password':
      return 'check PG_SSH_USER and PG_SSH_PASSWORD; the bastion may disable password auth';
  }
}

// Classify by the host-key flag and ssh2's structured level/code (not message text, so a host string
// containing a keyword is never misread); an unknown failure stays a generic SSH_CONNECT_FAILED.
function sshOpenError(err: unknown, sshConfig: SshConfig, authMethod: SshAuthMethod, hostKeyMismatch: boolean): ConnectionError {
  const at = `${sshConfig.host}:${sshConfig.port}`;
  const e = (typeof err === 'object' && err !== null ? err : {}) as { level?: string; code?: string; message?: string };
  const message = typeof e.message === 'string' && e.message !== '' ? e.message : String(err);
  if (hostKeyMismatch) {
    return new ConnectionError('SSH_HOST_KEY_MISMATCH', `SSH bastion host key does not match PG_SSH_FINGERPRINT (${at})`, { hint: `the bastion key changed or PG_SSH_FINGERPRINT is stale/wrong (or a man-in-the-middle); re-fetch it: ${FINGERPRINT_HINT}`, cause: err });
  }
  if (e.level === 'client-timeout') {
    return new ConnectionError('SSH_TIMEOUT', `SSH connection to the bastion timed out (${at})`, { hint: 'the bastion did not respond: check PG_SSH_HOST/PG_SSH_PORT, network/firewall, and PG_CONNECT_TIMEOUT', cause: err });
  }
  if (e.level === 'client-authentication') {
    return new ConnectionError('SSH_AUTH_FAILED', `SSH authentication to the bastion failed (${at})`, { hint: sshAuthHint(authMethod), cause: err });
  }
  if (e.level === 'client-socket' || e.level === 'client-dns' || (typeof e.code === 'string' && NETWORK_CODES.has(e.code))) {
    return new ConnectionError('SSH_CONNECT_FAILED', `could not reach the SSH bastion (${at})`, { hint: 'check PG_SSH_HOST and PG_SSH_PORT, and that the bastion is reachable', cause: err });
  }
  return new ConnectionError('SSH_CONNECT_FAILED', `SSH connection to the bastion failed (${at}): ${message}`, { cause: err });
}

// forward = the bastion could not reach the database; dropped = the SSH session went away. One mapper
// for the connect path and diagnose().
function tunnelFailureError(failure: TunnelFailure, target: { host: string; port: number }): ConnectionError {
  const at = `${target.host}:${target.port}`;
  if (failure.reason === 'forward') {
    return new ConnectionError('SSH_FORWARD_FAILED', `the SSH tunnel opened but the bastion could not reach the database (${at})`, { hint: 'check the database host and port as seen from the bastion, and that the bastion permits forwarding to it', cause: failure.cause });
  }
  return new ConnectionError('SSH_CONNECTION_LOST', `the SSH tunnel to the bastion dropped (${at})`, { hint: 'the tunnel closed (network drop or bastion restart); the next call reconnects - if it recurs, check PG_SSH_HOST/PG_SSH_PORT and PG_SSH_KEEPALIVE_INTERVAL', cause: failure.cause });
}

// --- tunnel lifecycle - owns the ssh client, listener, sockets, failure tracking, cleanup ---

interface TunnelFailure {
  reason: 'forward' | 'dropped';
  cause: unknown;
}

interface Tunnel {
  localPort: number;
  failure(): TunnelFailure | undefined;
  close(): Promise<void>;
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// Graceful end(), then force destroy() past the deadline, so shutdown never hangs on a stuck close.
function endClient(ssh: SshClientLike, alreadyClosed: () => boolean): Promise<void> {
  if (alreadyClosed()) {
    try { ssh.end(); } catch { /* no-op on an already-closed client */ }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => { if (done) return; done = true; clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { try { ssh.destroy(); } catch { /* best-effort force close */ } finish(); }, 5000);
    ssh.on('close', finish);
    try { ssh.end(); } catch { finish(); }
  });
}

/**
 * Loopback listener forwarding each socket through the SSH channel; also owns the SSH client. Binds
 * 127.0.0.1:0 (free port, plain TCP that works on Windows too). A drop before close() stops the
 * listener so pg reconnects and is recorded for failure(); a drop from our own close() is not.
 */
function openTunnel(ssh: SshClientLike, target: { host: string; port: number }): Promise<Tunnel> {
  const sockets = new Set<net.Socket>();
  let tunnelDown = false;
  let forwardError: Error | undefined;
  let droppedError: unknown;
  let sshClosed = false;
  let closing: Promise<void> | undefined;
  const server = net.createServer((socket) => {
    if (tunnelDown) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    try {
      ssh.forwardOut('127.0.0.1', 0, target.host, target.port, (err, channel) => {
        if (err !== undefined && err !== null) {
          forwardError = err;
          socket.destroy(err);
          return;
        }
        channel.on('error', () => socket.destroy());
        socket.pipe(channel).pipe(socket);
      });
    } catch (err) {
      // forwardOut throws synchronously ("Not connected") if SSH dropped between accept and here.
      forwardError = err instanceof Error ? err : new Error(String(err));
      socket.destroy(forwardError);
    }
  });
  const onDrop = (err?: unknown): void => {
    if (closing === undefined && droppedError === undefined) droppedError = err ?? new Error('SSH tunnel closed');
    tunnelDown = true;
    for (const s of sockets) s.destroy();
    try { server.close(); } catch { /* already closing/closed */ }
  };
  ssh.on('error', (err: unknown) => onDrop(err));
  ssh.on('close', () => { sshClosed = true; onDrop(); });
  ssh.on('end', () => onDrop());
  const close = (): Promise<void> => (closing ??= (async () => {
    for (const s of sockets) s.destroy();
    await closeServer(server);
    await endClient(ssh, () => sshClosed);
  })());
  return new Promise((resolve, reject) => {
    server.once('error', (err) => { try { ssh.end(); } catch { /* release the half-open client */ } reject(err); });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        localPort: typeof address === 'object' && address !== null ? address.port : 0,
        failure: () => forwardError !== undefined // forward is the more specific cause
          ? { reason: 'forward', cause: forwardError }
          : droppedError !== undefined ? { reason: 'dropped', cause: droppedError } : undefined,
        close,
      });
    });
  });
}

// --- connector - orchestrate configuration, tunnel, and pg into a Connection ---

function sshConnection(client: pg.Client, tunnel: Tunnel, target: { host: string; port: number }): Connection {
  let closing: Promise<void> | undefined;
  const teardown = async (): Promise<void> => {
    const errors: string[] = [];
    await client.end().catch((e: unknown) => errors.push(String(e)));
    await tunnel.close();
    if (errors.length > 0) throw new Error(`ssh connection cleanup failed: ${errors.join('; ')}`);
  };
  return {
    client,
    close: () => (closing ??= teardown()),
    diagnose: (): ConnectionError | undefined => {
      const failure = tunnel.failure();
      return failure === undefined ? undefined : tunnelFailureError(failure, target);
    },
  };
}

export function createSshConnector(sshConfig: SshConfig, deps: SshConnectorDeps = defaultDeps): Connector {
  return {
    async connect(cfg) {
      const options = resolveClientOptions(cfg);
      const target = { host: options.host ?? 'localhost', port: typeof options.port === 'number' ? options.port : 5432 };
      let hostKeyMismatch = false;
      const config = buildSshConnectConfig(sshConfig, cfg.connectTimeoutMs, process.env, () => { hostKeyMismatch = true; });
      const authMethod = authMethodOf(config);
      await ensureValidKey(config, deps);
      let ssh: SshClientLike;
      try {
        ssh = await deps.openSsh(config);
      } catch (err) {
        throw sshOpenError(err, sshConfig, authMethod, hostKeyMismatch);
      }
      const tunnel = await openTunnel(ssh, target);
      try {
        const client = deps.createPgClient({ ...options, host: '127.0.0.1', port: tunnel.localPort, ...sslForTunnel(options.ssl, target.host) });
        await client.connect();
        return sshConnection(client, tunnel, target);
      } catch (err) {
        await tunnel.close();
        // A recorded tunnel failure is the real cause; otherwise the tunnel is healthy and this is a
        // genuine PostgreSQL error - keep its own mapping.
        const failure = tunnel.failure();
        if (failure !== undefined) throw tunnelFailureError(failure, target);
        throw err;
      }
    },
  };
}
