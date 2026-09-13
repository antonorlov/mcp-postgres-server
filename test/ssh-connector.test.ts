// SSH connector logic with injected fakes - no real bastion. Pure pieces (host-key verification, auth
// config, TLS servername) plus the connect()/close() lifecycle via the deps seam; the real
// socket<->ssh<->pg wiring is proven by the stand's SSH-bastion E2E.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { loadConfig, type SshConfig } from '../src/index.js';
import {
  buildHostVerifier,
  buildSshConnectConfig,
  createSshConnector,
  defaultKeyPath,
  sslForTunnel,
  type SshClientLike,
  type SshConnectorDeps,
} from '../src/ssh-connector.js';

const dir = mkdtempSync(join(tmpdir(), 'mcp-ssh-'));
const KEY_PATH = join(dir, 'id_ed25519');
writeFileSync(KEY_PATH, 'PRIVATE-KEY-BYTES');
// A fake $HOME with a default key, for the "default keys" auth path.
const HOME_WITH_KEY = join(dir, 'home');
mkdirSync(join(HOME_WITH_KEY, '.ssh'), { recursive: true });
writeFileSync(join(HOME_WITH_KEY, '.ssh', 'id_ed25519'), 'DEFAULT-KEY-BYTES');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Minimal SSH config with host-key verification satisfied via a well-formed pinned fingerprint
// (43 base64 chars, as a real SHA256 fingerprint is).
const VALID_FP = `SHA256:${'A'.repeat(43)}`;
const BASE: SshConfig = { host: 'bastion', port: 22, fingerprint: VALID_FP, keepaliveIntervalMs: 15000 };

function makeSsh() {
  const events: Record<string, Array<(...a: unknown[]) => void>> = {};
  return {
    ended: 0,
    forwardOut: () => undefined,
    end(): void {
      this.ended++;
      this.emit('close'); // a real ssh2 client emits 'close' after end(); teardown awaits it
    },
    on(event: string, cb: (...a: unknown[]) => void) {
      (events[event] ??= []).push(cb);
      return this;
    },
    emit(event: string, ...args: unknown[]): void {
      (events[event] ?? []).forEach((cb) => cb(...args));
    },
    listeners: (event: string) => events[event] ?? [],
  };
}

function makePg(opts: { connectError?: Error } = {}) {
  return {
    options: undefined as pg.ClientConfig | undefined,
    connected: 0,
    ended: 0,
    async connect(): Promise<void> {
      this.connected++;
      if (opts.connectError) throw opts.connectError;
    },
    async end(): Promise<void> {
      this.ended++;
    },
  };
}

function depsFor(ssh: ReturnType<typeof makeSsh>, client: ReturnType<typeof makePg>, openError?: Error, keyError?: Error): SshConnectorDeps {
  return {
    openSsh: async () => {
      if (openError) throw openError;
      return ssh as unknown as SshClientLike;
    },
    createPgClient: (options) => {
      client.options = options;
      return client as unknown as pg.Client;
    },
    validateKey: async () => keyError, // parseKey stand-in: undefined = valid
  };
}

describe('buildHostVerifier', () => {
  const key = Buffer.from('the-host-key-blob');
  const fp = createHash('sha256').update(key).digest('base64');

  it('accepts a matching pinned fingerprint (with or without the SHA256: prefix and = padding)', () => {
    expect(buildHostVerifier({ ...BASE, fingerprint: fp })(key)).toBe(true);
    expect(buildHostVerifier({ ...BASE, fingerprint: `SHA256:${fp}` })(key)).toBe(true);
  });

  it('rejects a non-matching but well-formed fingerprint', () => {
    expect(buildHostVerifier({ ...BASE, fingerprint: `SHA256:${'B'.repeat(43)}` })(key)).toBe(false);
  });

  it('rejects a malformed fingerprint up front (SSH_CONFIG_INVALID), not as an ambiguous mismatch', () => {
    expect(() => buildHostVerifier({ ...BASE, fingerprint: 'deadbeef' })).toThrow(/not a valid SHA256 fingerprint/);
    expect(() => buildHostVerifier({ ...BASE, fingerprint: 'aa:bb:cc:dd' })).toThrow(/not a valid SHA256 fingerprint/);
  });

  it('fails closed when no fingerprint is configured (fingerprint is the only host-key mode)', () => {
    expect(() => buildHostVerifier({ host: 'bastion', port: 22, keepaliveIntervalMs: 15000 })).toThrow(/host-key verification is required: set PG_SSH_FINGERPRINT/);
  });
});

describe('buildSshConnectConfig', () => {
  it('reads the private key and carries keepalive, readyTimeout, and the host verifier', () => {
    const conf = buildSshConnectConfig({ ...BASE, user: 'jump', privateKeyPath: KEY_PATH, passphrase: 'pw' }, 9000);
    expect(conf).toMatchObject({ host: 'bastion', port: 22, username: 'jump', readyTimeout: 9000, keepaliveInterval: 15000, keepaliveCountMax: 3, passphrase: 'pw' });
    expect((conf.privateKey as Buffer).toString()).toBe('PRIVATE-KEY-BYTES');
    expect(typeof conf.hostVerifier).toBe('function');
  });

  it('resolves agent="true" from SSH_AUTH_SOCK and throws if it is unset', () => {
    expect(buildSshConnectConfig({ ...BASE, agent: 'true' }, 1000, { SSH_AUTH_SOCK: '/run/agent.sock' }).agent).toBe('/run/agent.sock');
    expect(() => buildSshConnectConfig({ ...BASE, agent: 'true' }, 1000, {})).toThrow(/SSH_AUTH_SOCK/);
  });

  it('uses an explicit agent socket path (e.g. a Windows named pipe)', () => {
    expect(buildSshConnectConfig({ ...BASE, agent: '\\\\.\\pipe\\openssh-ssh-agent' }, 1000, {}).agent).toBe('\\\\.\\pipe\\openssh-ssh-agent');
  });

  it('uses an explicit password, but a key or agent takes precedence over it', () => {
    expect(buildSshConnectConfig({ ...BASE, password: 'pw' }, 1000, {}).password).toBe('pw');
    const withKey = buildSshConnectConfig({ ...BASE, privateKeyPath: KEY_PATH, password: 'pw' }, 1000, {});
    expect(withKey.password).toBeUndefined();
    expect((withKey.privateKey as Buffer).toString()).toBe('PRIVATE-KEY-BYTES');
  });

  it('falls back to a running agent (SSH_AUTH_SOCK) when nothing explicit is configured', () => {
    expect(buildSshConnectConfig({ ...BASE }, 1000, { SSH_AUTH_SOCK: '/run/user/agent.sock' }).agent).toBe('/run/user/agent.sock');
  });

  it('falls back to a default key file (~/.ssh/id_ed25519) when there is no agent', () => {
    const conf = buildSshConnectConfig({ ...BASE }, 1000, { HOME: HOME_WITH_KEY });
    expect((conf.privateKey as Buffer).toString()).toBe('DEFAULT-KEY-BYTES');
  });

  it('throws when no key, agent, default key, or SSH_AUTH_SOCK is available', () => {
    expect(() => buildSshConnectConfig({ ...BASE }, 1000, { HOME: dir })).toThrow(/SSH authentication required/);
  });
});

describe('defaultKeyPath', () => {
  it('finds a default key under $HOME/.ssh', () => {
    expect(defaultKeyPath({ HOME: HOME_WITH_KEY })).toBe(join(HOME_WITH_KEY, '.ssh', 'id_ed25519'));
  });

  it('falls back to %USERPROFILE% when HOME is unset (Windows)', () => {
    expect(defaultKeyPath({ USERPROFILE: HOME_WITH_KEY })).toBe(join(HOME_WITH_KEY, '.ssh', 'id_ed25519'));
  });

  it('returns undefined when no home is set or no default key exists', () => {
    expect(defaultKeyPath({})).toBeUndefined();
    expect(defaultKeyPath({ HOME: dir })).toBeUndefined();
  });
});

describe('sslForTunnel', () => {
  it('preserves the original hostname as servername on an object ssl policy', () => {
    expect(sslForTunnel({ rejectUnauthorized: false }, 'db.example.com')).toEqual({ ssl: { rejectUnauthorized: false, servername: 'db.example.com' } });
  });

  it('passes a boolean ssl through and maps undefined to no ssl option', () => {
    expect(sslForTunnel(false, 'db')).toEqual({ ssl: false });
    expect(sslForTunnel(undefined, 'db')).toEqual({});
  });
});

describe('createSshConnector.connect', () => {
  const cfg = () => loadConfig({ DATABASE_URL: 'postgres://u:p@db.example.com:5433/app' });
  const ssh256 = { ...BASE, agent: '/tmp/a.sock' }; // valid auth + host verification, no file reads

  it('returns an owned connection: pg connects through 127.0.0.1 with the original TLS servername', async () => {
    const ssh = makeSsh();
    const pgc = makePg();
    const conn = await createSshConnector(ssh256, depsFor(ssh, pgc)).connect(loadConfig({ DATABASE_URL: 'postgres://u:p@db.example.com:5433/app?sslmode=verify-full', PG_SSL_CA: KEY_PATH }));
    expect(pgc.connected).toBe(1);
    expect(pgc.options).toMatchObject({ host: '127.0.0.1', user: 'u', database: 'app', pipeline: true });
    expect(typeof pgc.options?.port).toBe('number');
    expect((pgc.options?.ssl as { servername?: string }).servername).toBe('db.example.com');
    expect(ssh.listeners('error').length).toBe(1); // tunnel-drop wiring in place
    await conn.close();
    await conn.close(); // idempotent
    expect(pgc.ended).toBe(1);
    expect(ssh.ended).toBe(1);
  });

  it('releases the SSH client when the PostgreSQL connect fails after the tunnel opened', async () => {
    const ssh = makeSsh();
    const pgc = makePg({ connectError: new Error('auth failed') });
    await expect(createSshConnector(ssh256, depsFor(ssh, pgc)).connect(cfg())).rejects.toThrow('auth failed');
    expect(ssh.ended).toBe(1);
  });

  it('classifies an SSH open failure by ssh2 structured level/code and opens no pg client', async () => {
    const cases: Array<[Error, string]> = [
      [Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' }), 'SSH_AUTH_FAILED'],
      [Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:22'), { level: 'client-socket', code: 'ECONNREFUSED' }), 'SSH_CONNECT_FAILED'],
      [Object.assign(new Error('Timed out while waiting for handshake'), { level: 'client-timeout' }), 'SSH_TIMEOUT'],
    ];
    for (const [openError, code] of cases) {
      const pgc = makePg();
      await expect(createSshConnector(ssh256, depsFor(makeSsh(), pgc, openError)).connect(cfg())).rejects.toMatchObject({ code });
      expect(pgc.connected).toBe(0);
    }
  });

  it('trusts structured fields over message text: an ENOTFOUND host containing a keyword is SSH_CONNECT_FAILED, not SSH_KEY_INVALID', async () => {
    const enotfound = Object.assign(new Error('getaddrinfo ENOTFOUND encrypted-bastion.example'), { level: 'client-dns', code: 'ENOTFOUND' });
    await expect(createSshConnector(ssh256, depsFor(makeSsh(), makePg(), enotfound)).connect(cfg())).rejects.toMatchObject({ code: 'SSH_CONNECT_FAILED' });
  });

  it('validates the private key up front (SSH_KEY_INVALID) before opening the SSH connection', async () => {
    const ssh = makeSsh();
    const pgc = makePg();
    const withKey: SshConfig = { ...BASE, privateKeyPath: KEY_PATH };
    await expect(createSshConnector(withKey, depsFor(ssh, pgc, undefined, new Error('Encrypted private key detected, but no passphrase given'))).connect(cfg()))
      .rejects.toMatchObject({ code: 'SSH_KEY_INVALID' });
    expect(ssh.ended).toBe(0); // never opened the SSH connection
    expect(pgc.connected).toBe(0);
  });

  it('names SSH without inventing a cause when the open failure is unrecognized', async () => {
    const pgc = makePg();
    await expect(createSshConnector(ssh256, depsFor(makeSsh(), pgc, new Error('handshake refused'))).connect(cfg()))
      .rejects.toMatchObject({ code: 'SSH_CONNECT_FAILED', message: expect.stringContaining('handshake refused') });
  });

  it('an auth failure hint names the settings for the auth method actually used (agent here)', async () => {
    const err = await createSshConnector(ssh256, depsFor(makeSsh(), makePg(), Object.assign(new Error('x'), { level: 'client-authentication' })))
      .connect(cfg()).catch((e: unknown) => e as { hint?: string });
    expect(err.hint).toMatch(/agent|SSH_AUTH_SOCK|PG_SSH_AGENT/);
  });

  it('a genuine PostgreSQL error through a healthy tunnel keeps its own message (not an SSH code)', async () => {
    const pgc = makePg({ connectError: Object.assign(new Error('password authentication failed'), { code: '28P01' }) });
    await expect(createSshConnector(ssh256, depsFor(makeSsh(), pgc)).connect(cfg()))
      .rejects.toMatchObject({ code: '28P01', message: expect.stringContaining('password authentication failed') });
  });

  it('classifies an SSH drop DURING the pg connect as SSH_CONNECTION_LOST, not a generic pg EOF', async () => {
    const ssh = makeSsh();
    const pgc = {
      options: undefined as pg.ClientConfig | undefined, connected: 0, ended: 0,
      async connect(): Promise<void> { this.connected++; ssh.emit('close'); throw new Error('Connection terminated unexpectedly'); },
      async end(): Promise<void> { this.ended++; },
    };
    const deps: SshConnectorDeps = {
      openSsh: async () => ssh as unknown as SshClientLike,
      createPgClient: (o) => { pgc.options = o; return pgc as unknown as pg.Client; },
      validateKey: async () => undefined,
    };
    await expect(createSshConnector(ssh256, deps).connect(cfg())).rejects.toMatchObject({ code: 'SSH_CONNECTION_LOST' });
  });

  it('diagnose() preserves the tunnel-loss cause through the automatic cleanup the drop triggers', async () => {
    const ssh = makeSsh();
    const conn = await createSshConnector(ssh256, depsFor(ssh, makePg())).connect(cfg());
    ssh.emit('close'); // tunnel drops mid-session
    const closing = conn.close(); // cleanup starts before the failed query reads the diagnosis
    expect(conn.diagnose?.()?.code).toBe('SSH_CONNECTION_LOST');
    await closing;
  });

  it('diagnose() returns nothing for an intentional close with no prior drop', async () => {
    const conn = await createSshConnector(ssh256, depsFor(makeSsh(), makePg())).connect(cfg());
    await conn.close();
    expect(conn.diagnose?.()).toBeUndefined();
  });

  it('rejects before opening anything when host-key verification is not configured', async () => {
    const ssh = makeSsh();
    const pgc = makePg();
    // No fingerprint -> fail closed at config build, before any socket or handshake.
    const noVerify: SshConfig = { host: 'bastion', port: 22, agent: '/tmp/a.sock', keepaliveIntervalMs: 15000 };
    await expect(createSshConnector(noVerify, depsFor(ssh, pgc)).connect(cfg())).rejects.toThrow(/host-key verification is required/);
    expect(ssh.ended).toBe(0);
    expect(pgc.connected).toBe(0);
  });

  it('preserves full pg options (application_name, options/search_path) across the tunnel', async () => {
    const ssh = makeSsh();
    const pgc = makePg();
    await createSshConnector(ssh256, depsFor(ssh, pgc)).connect(loadConfig({ DATABASE_URL: 'postgres://u:p@db.example.com:5433/app?application_name=mcp&options=-c%20search_path%3Dapp' }));
    expect(pgc.options).toMatchObject({ host: '127.0.0.1', database: 'app', application_name: 'mcp', options: '-c search_path=app' });
  });

  it('awaits a single teardown for concurrent close() calls (ssh and pg each end once)', async () => {
    const ssh = makeSsh();
    const pgc = makePg();
    const conn = await createSshConnector(ssh256, depsFor(ssh, pgc)).connect(cfg());
    await Promise.all([conn.close(), conn.close(), conn.close()]);
    expect(ssh.ended).toBe(1);
    expect(pgc.ended).toBe(1);
  });
});
