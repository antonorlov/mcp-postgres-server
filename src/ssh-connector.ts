/**
 * Optional SSH-tunnel connector, loaded by main() via dynamic import only when PG_SSH_HOST is set,
 * so a direct connection pulls neither this module nor its `ssh2` optional dependency. Same Connector
 * contract as the direct connector; close() releases every resource once, awaiting actual closure.
 *
 *   pg.Client -> 127.0.0.1 listener -> ssh2 forwardOut -> SSH bastion -> PostgreSQL
 *
 * SSH is pure transport: no SQL and no per-query handshake, and the pg client options come from the
 * same resolveClientOptions the direct connector uses, so only the transport differs.
 */
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { resolveClientOptions, type Connection, type Connector, type ServerConfig, type SshConfig } from './index.js';
import type { ConnectConfig } from 'ssh2';

// The slice of ssh2's Client used here, typed structurally so tests inject a fake and ssh2 stays a
// lazy runtime import.
export interface SshClientLike {
  forwardOut(srcHost: string, srcPort: number, dstHost: string, dstPort: number, cb: (err: Error | undefined, channel: Duplex) => void): void;
  end(): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

// Injectable boundaries (real ssh2 + pg by default) so tests drive the connector without a bastion.
export interface SshConnectorDeps {
  openSsh(config: ConnectConfig): Promise<SshClientLike>;
  createPgClient(options: pg.ClientConfig): pg.Client;
}

const defaultDeps: SshConnectorDeps = {
  async openSsh(config) {
    const { Client } = await import('ssh2');
    const client = new Client();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        client.removeListener('ready', onReady);
        client.removeListener('error', onFail);
        client.removeListener('close', onClose);
        client.removeListener('end', onClose);
      };
      const succeed = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const failWith = (err: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        try { client.end(); } catch { /* releasing a half-open client */ }
        reject(err);
      };
      const onReady = (): void => succeed();
      const onFail = (err: unknown): void => failWith(err instanceof Error ? err : new Error(String(err)));
      // A premature end/close during the handshake clears ssh2's own timer; settling as a failure
      // here keeps the promise from hanging forever and blocking the database queue.
      const onClose = (): void => failWith(new Error('SSH connection closed before it became ready'));
      const setupDeadlineMs = (config.readyTimeout ?? 10000) + 2000; // ready timeout + margin
      const timer = setTimeout(() => failWith(new Error(`SSH setup timed out after ${setupDeadlineMs}ms`)), setupDeadlineMs);
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

// Fail-closed host-key verification: a pinned SHA256 fingerprint must match, else refuse to connect
// rather than trust any key (ssh2's default).
export function buildHostVerifier(sshConfig: SshConfig): (key: Buffer) => boolean {
  if (sshConfig.fingerprint === undefined) {
    throw new Error('SSH host-key verification is required: set PG_SSH_FINGERPRINT');
  }
  const want = normalizeFingerprint(sshConfig.fingerprint);
  return (key) => normalizeFingerprint(createHash('sha256').update(key).digest('base64')) === want;
}

// Ignores the "SHA256:" prefix and base64 "=" padding.
function normalizeFingerprint(fp: string): string {
  return fp.replace(/^SHA256:/i, '').replace(/=+$/, '');
}

// The default key ssh would try, under $HOME (or %USERPROFILE% on Windows): first of id_ed25519 /
// id_rsa / id_ecdsa that exists, else undefined.
export function defaultKeyPath(env: NodeJS.ProcessEnv): string | undefined {
  const home = env.HOME ?? env.USERPROFILE;
  if (home === undefined || home === '') return undefined;
  for (const name of ['id_ed25519', 'id_rsa', 'id_ecdsa']) {
    const path = join(home, '.ssh', name);
    if (existsSync(path)) return path;
  }
  return undefined;
}

// ssh2 connect options from PG_SSH_*. Auth resolves like ssh: an explicit key, agent, or password
// wins (in that order); otherwise fall back to a running agent (SSH_AUTH_SOCK), then a default key file.
export function buildSshConnectConfig(sshConfig: SshConfig, connectTimeoutMs: number, env: NodeJS.ProcessEnv = process.env): ConnectConfig {
  const config: ConnectConfig = {
    host: sshConfig.host,
    port: sshConfig.port,
    username: sshConfig.user,
    readyTimeout: connectTimeoutMs,
    keepaliveInterval: sshConfig.keepaliveIntervalMs,
    keepaliveCountMax: 3,
    hostVerifier: buildHostVerifier(sshConfig),
  };
  const useKey = (path: string): void => {
    config.privateKey = readFileSync(path);
    if (sshConfig.passphrase !== undefined) config.passphrase = sshConfig.passphrase;
  };
  if (sshConfig.privateKeyPath !== undefined) {
    useKey(sshConfig.privateKeyPath);
  } else if (sshConfig.agent !== undefined) {
    // 'true' means the ambient agent (SSH_AUTH_SOCK); anything else is a socket/named-pipe path.
    const agent = sshConfig.agent === 'true' ? env.SSH_AUTH_SOCK : sshConfig.agent;
    if (agent === undefined || agent === '') {
      throw new Error('PG_SSH_AGENT=true but SSH_AUTH_SOCK is not set');
    }
    config.agent = agent;
  } else if (sshConfig.password !== undefined) {
    config.password = sshConfig.password;
  } else if (env.SSH_AUTH_SOCK !== undefined && env.SSH_AUTH_SOCK !== '') {
    config.agent = env.SSH_AUTH_SOCK;
  } else {
    const keyPath = defaultKeyPath(env);
    if (keyPath === undefined) {
      throw new Error('SSH authentication required: set PG_SSH_PRIVATE_KEY, PG_SSH_AGENT, or PG_SSH_PASSWORD, or provide a default key (~/.ssh/id_ed25519) or a running agent (SSH_AUTH_SOCK)');
    }
    useKey(keyPath);
  }
  return config;
}

// Keep the ORIGINAL database hostname for SNI and certificate validation, though the socket connects
// to 127.0.0.1 - else verify-full breaks through the loopback.
export function sslForTunnel(ssl: pg.ClientConfig['ssl'], realHost: string): { ssl?: pg.ClientConfig['ssl'] } {
  if (ssl === undefined) return {};
  if (typeof ssl === 'object') return { ssl: { ...ssl, servername: realHost } };
  return { ssl };
}

interface Forwarder {
  server: net.Server;
  localPort: number;
  sockets: Set<net.Socket>;
}

/**
 * Loopback listener forwarding each incoming socket through the tunnel. Binds 127.0.0.1:0 (an
 * OS-assigned free port, never occupied; a plain TCP socket that works on Windows too). When the
 * tunnel dies it stops accepting and drops live sockets so pg sees the break and reconnects; a
 * late/failed forward becomes a socket error, never an uncaught exception that crashes the process.
 */
function openForwarder(ssh: SshClientLike, target: { host: string; port: number }): Promise<Forwarder> {
  const sockets = new Set<net.Socket>();
  let tunnelDown = false;
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
          socket.destroy(err);
          return;
        }
        channel.on('error', () => socket.destroy());
        socket.pipe(channel).pipe(socket);
      });
    } catch (err) {
      // forwardOut throws synchronously ("Not connected") if SSH dropped between accept and here.
      socket.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  });
  const onTunnelDown = (): void => {
    tunnelDown = true;
    for (const s of sockets) s.destroy();
    try { server.close(); } catch { /* already closing/closed */ }
  };
  ssh.on('error', onTunnelDown);
  ssh.on('close', onTunnelDown);
  ssh.on('end', onTunnelDown);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, localPort: typeof address === 'object' && address !== null ? address.port : 0, sockets });
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// Await the SSH client's actual close (bounded), initiating it if it has not already happened.
function endSsh(ssh: SshClientLike, alreadyClosed: () => boolean): Promise<void> {
  if (alreadyClosed()) {
    try { ssh.end(); } catch { /* no-op on an already-closed client */ }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000); // safety net: never hang shutdown on a stuck close
    ssh.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      ssh.end();
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

// One owned Connection whose close() resolves only once pg client, sockets, listener, and SSH have
// ACTUALLY closed. Idempotent: concurrent/repeat close() calls await the one teardown.
function ownedConnection(ssh: SshClientLike, server: net.Server, sockets: Set<net.Socket>, client: pg.Client): Connection {
  let sshClosed = false;
  ssh.on('close', () => { sshClosed = true; });
  let closing: Promise<void> | undefined;
  const teardown = async (): Promise<void> => {
    const errors: string[] = [];
    await client.end().catch((e: unknown) => errors.push(String(e)));
    for (const s of sockets) s.destroy();
    await closeServer(server);
    await endSsh(ssh, () => sshClosed);
    if (errors.length > 0) throw new Error(`ssh connection cleanup failed: ${errors.join('; ')}`);
  };
  return {
    client,
    close: () => (closing ??= teardown()),
  };
}

// Creating the connector opens nothing; each connect() opens a fresh tunnel + pg client and returns
// one owned Connection. A partial startup failure releases whatever was already opened before rejecting.
export function createSshConnector(sshConfig: SshConfig, deps: SshConnectorDeps = defaultDeps): Connector {
  return {
    async connect(cfg) {
      const options = resolveClientOptions(cfg);
      const realHost = options.host ?? 'localhost';
      const realPort = typeof options.port === 'number' ? options.port : 5432;
      const sshConf = buildSshConnectConfig(sshConfig, cfg.connectTimeoutMs); // throws before opening anything if misconfigured
      const ssh = await deps.openSsh(sshConf);
      try {
        const { server, localPort, sockets } = await openForwarder(ssh, { host: realHost, port: realPort });
        try {
          const client = deps.createPgClient({
            ...options,
            host: '127.0.0.1',
            port: localPort,
            ...sslForTunnel(options.ssl, realHost),
          });
          await client.connect();
          return ownedConnection(ssh, server, sockets, client);
        } catch (err) {
          for (const s of sockets) s.destroy();
          await closeServer(server);
          throw err;
        }
      } catch (err) {
        await endSsh(ssh, () => false);
        throw err;
      }
    },
  };
}
