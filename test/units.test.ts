// Pure-function units: capBySize, classifyPgError, loadConfig, resolveClientOptions. Pin the
// safe-by-default posture (read-only unless PG_ALLOW_WRITE, connect_db off unless PG_ENABLE_RUNTIME_CONNECT).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { baseClientOptions, capBySize, classifyPgError, defaultClientFactory, loadConfig, resolveClientOptions } from '../src/index.js';

describe('capBySize', () => {
  it('keeps every row when the combined JSON size fits the budget', () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(capBySize(rows, 1000)).toEqual({ rows, truncated: false });
  });

  it('drops rows past the byte budget and flags truncation', () => {
    const rows = [{ a: 'x'.repeat(50) }, { a: 'y'.repeat(50) }, { a: 'z'.repeat(50) }];
    const { rows: kept, truncated } = capBySize(rows, 80);
    expect(truncated).toBe(true);
    expect(kept.length).toBe(1);
  });

  it('returns no rows (truncated) when not even the first row fits the budget', () => {
    const rows = [{ a: 'x'.repeat(1000) }, { a: 'y' }];
    expect(capBySize(rows, 10)).toEqual({ rows: [], truncated: true });
  });

  it('measures utf-8 bytes, not characters', () => {
    const rows = [{ s: 'é'.repeat(20) }, { s: 'é'.repeat(20) }]; // a 2-byte UTF-8 char
    expect(capBySize(rows, 45).truncated).toBe(true);
  });

  it('handles an empty result set', () => {
    expect(capBySize([], 100)).toEqual({ rows: [], truncated: false });
  });
});

describe('classifyPgError', () => {
  const pgError = (message: string, code: string) =>
    Object.assign(new Error(message), { code });

  it.each([
    ['28P01', 'password authentication failed for user "app"', /PG_USER|PG_PASSWORD/],
    ['3D000', 'database "nope" does not exist', /PG_DATABASE/],
    ['42P01', 'relation "userz" does not exist', /list_tables/],
    ['42703', 'column "nmae" does not exist', /describe_table/],
    ['57014', 'canceling statement due to statement timeout', /LIMIT/i],
    ['25006', 'cannot execute INSERT in a read-only transaction', /PG_ALLOW_WRITE/],
  ])('maps SQLSTATE %s to an actionable hint', (code, message, hintPattern) => {
    const classified = classifyPgError(pgError(message, code));
    expect(classified.message).toBe(message);
    expect(classified.code).toBe(code);
    expect(classified.hint).toMatch(hintPattern);
  });

  it.each(['ECONNREFUSED', 'ENOTFOUND'])(
    'maps connection error %s to a host/port hint',
    (code) => {
      const classified = classifyPgError(pgError('connect failed', code));
      expect(classified.hint).toMatch(/PG_HOST|PG_PORT|DATABASE_URL/);
    }
  );

  it('returns message only for unknown SQLSTATE codes', () => {
    const classified = classifyPgError(pgError('something odd', '99999'));
    expect(classified.message).toBe('something odd');
    expect(classified.hint).toBeUndefined();
  });

  it('copes with non-Error throwables', () => {
    const classified = classifyPgError('kaboom');
    expect(classified.message).toContain('kaboom');
    expect(classified.hint).toBeUndefined();
  });
});

describe('loadConfig', () => {
  it('applies safe defaults: readOnly, 32 KiB result budget, 30s timeout, no runtime connect', () => {
    const cfg = loadConfig({});
    expect(cfg.readOnly).toBe(true);
    expect(cfg.maxResultBytes).toBe(32768);
    expect(cfg.statementTimeoutMs).toBe(30_000);
    expect(cfg.allowRuntimeConnect).toBe(false);
  });

  it('prefers DATABASE_URL over PG_* variables', () => {
    const url = 'postgres://u:p@url-host:5433/urldb';
    const cfg = loadConfig({
      DATABASE_URL: url,
      PG_HOST: 'env-host',
      PG_USER: 'env-user',
      PG_PASSWORD: 'env-pass',
      PG_DATABASE: 'envdb',
    });
    // connectionString set means the connection is built from the URL; the
    // client factory must ignore the PG_* fields whenever it is present.
    expect(cfg.connectionString).toBe(url);
  });

  it('falls back to PG_* variables when DATABASE_URL is absent', () => {
    const cfg = loadConfig({
      PG_HOST: 'localhost',
      PG_PORT: '5433',
      PG_USER: 'app',
      PG_PASSWORD: 'secret',
      PG_DATABASE: 'appdb',
    });
    expect(cfg.connectionString).toBeUndefined();
    expect(cfg.host).toBe('localhost');
    expect(cfg.port).toBe(5433); // parsed to a number
    expect(cfg.user).toBe('app');
    expect(cfg.password).toBe('secret');
    expect(cfg.database).toBe('appdb');
  });

  it('PG_ALLOW_WRITE=true flips readOnly off - anything else stays read-only (fail closed)', () => {
    expect(loadConfig({ PG_ALLOW_WRITE: 'true' }).readOnly).toBe(false);
    expect(loadConfig({ PG_ALLOW_WRITE: '1' }).readOnly).toBe(true);
    expect(loadConfig({ PG_ALLOW_WRITE: 'TRUE' }).readOnly).toBe(true);
    expect(loadConfig({ PG_ALLOW_WRITE: '' }).readOnly).toBe(true);
    expect(loadConfig({}).readOnly).toBe(true);
  });

  it('PG_ENABLE_RUNTIME_CONNECT=true enables connect_db registration', () => {
    expect(loadConfig({ PG_ENABLE_RUNTIME_CONNECT: 'true' }).allowRuntimeConnect).toBe(true);
    expect(loadConfig({ PG_ENABLE_RUNTIME_CONNECT: 'false' }).allowRuntimeConnect).toBe(false);
  });

  it('parses PG_MAX_RESULT_BYTES and PG_STATEMENT_TIMEOUT as numbers', () => {
    const cfg = loadConfig({ PG_MAX_RESULT_BYTES: '8192', PG_STATEMENT_TIMEOUT: '5000' });
    expect(cfg.maxResultBytes).toBe(8192);
    expect(cfg.statementTimeoutMs).toBe(5000);
  });

  it('falls back to defaults for non-positive or junk PG_MAX_RESULT_BYTES / PG_STATEMENT_TIMEOUT', () => {
    const cfg = loadConfig({ PG_MAX_RESULT_BYTES: '0', PG_STATEMENT_TIMEOUT: 'abc' });
    expect(cfg.maxResultBytes).toBe(32768);
    expect(cfg.statementTimeoutMs).toBe(30000);
  });

  it('parses PG_CONNECT_TIMEOUT, defaulting to 10000', () => {
    expect(loadConfig({}).connectTimeoutMs).toBe(10000);
    expect(loadConfig({ PG_CONNECT_TIMEOUT: '2500' }).connectTimeoutMs).toBe(2500);
    expect(loadConfig({ PG_CONNECT_TIMEOUT: 'junk' }).connectTimeoutMs).toBe(10000);
  });

  describe('PG_PORT parsing', () => {
    it('parses a valid port and leaves it undefined when unset or empty', () => {
      expect(loadConfig({ PG_PORT: '6543' }).port).toBe(6543);
      expect(loadConfig({}).port).toBeUndefined();
      expect(loadConfig({ PG_PORT: '' }).port).toBeUndefined();
    });

    it('accepts the boundary ports 1 and 65535', () => {
      expect(loadConfig({ PG_PORT: '1' }).port).toBe(1);
      expect(loadConfig({ PG_PORT: '65535' }).port).toBe(65535);
    });

    it('falls back to 5432 for non-numeric junk (lenient, like 0.1.x)', () => {
      expect(loadConfig({ PG_PORT: 'abc' }).port).toBe(5432);
    });

    it.each(['0', '-1', '65536', '54340000', '99999'])(
      'throws for an out-of-range port %s instead of hanging a connection',
      (port) => {
        expect(() => loadConfig({ PG_PORT: port })).toThrow(/PG_PORT.*between 1 and 65535/);
      }
    );
  });

  describe('sslmode parsing', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'mcp-pg-ssl-'));
    afterAll(() => rmSync(scratch, { recursive: true, force: true }));

    it('PG_SSLMODE=disable yields no ssl', () => {
      const cfg = loadConfig({ PG_HOST: 'h', PG_SSLMODE: 'disable' });
      expect(cfg.ssl ?? false).toBe(false);
    });

    it('PG_SSLMODE=require encrypts without certificate verification (libpq semantics)', () => {
      const cfg = loadConfig({ PG_HOST: 'h', PG_SSLMODE: 'require' });
      expect(cfg.ssl).toEqual({ rejectUnauthorized: false });
    });

    it('PG_SSLMODE=verify-full verifies the server certificate with rejectUnauthorized pinned on', () => {
      const cfg = loadConfig({ PG_HOST: 'h', PG_SSLMODE: 'verify-full' });
      // Pinned explicitly (not left to Node's default) so an inherited NODE_TLS_REJECT_UNAUTHORIZED=0
      // cannot silently disable verification.
      expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
    });

    it('PG_SSL_CA points at a CA file whose contents are loaded for pg/tls', () => {
      const caPath = join(scratch, 'ca.pem');
      const pem = '-----BEGIN CERTIFICATE-----\nMIIFakeTestCertificate\n-----END CERTIFICATE-----\n';
      writeFileSync(caPath, pem);
      const cfg = loadConfig({ PG_HOST: 'h', PG_SSLMODE: 'verify-full', PG_SSL_CA: caPath });
      expect(typeof cfg.ssl).toBe('object');
      const ssl = cfg.ssl as { ca?: string };
      expect(ssl.ca).toContain('BEGIN CERTIFICATE');
    });

    it('derives ssl from sslmode in DATABASE_URL', () => {
      const on = loadConfig({ DATABASE_URL: 'postgres://u:p@db.example.com:5432/app?sslmode=require' });
      expect(on.ssl).toEqual({ rejectUnauthorized: false });

      const off = loadConfig({ DATABASE_URL: 'postgres://u:p@db.example.com:5432/app?sslmode=disable' });
      expect(off.ssl ?? false).toBe(false);
    });

    it('honours ssl=true|false and case-insensitive sslmode from the URL', () => {
      // ?ssl=true means verified TLS (native pg default), not plaintext and not no-verify.
      expect(loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/db?ssl=true' }).ssl).toEqual({ rejectUnauthorized: true });
      expect(loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/db?ssl=0' }).ssl ?? false).toBe(false);
      // sslmode wins over ssl, and the key is read case-insensitively.
      expect(loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/db?SSLMODE=verify-full' }).ssl).toEqual({ rejectUnauthorized: true });
      expect(loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/db?sslmode=verify-full&ssl=0' }).ssl).toEqual({ rejectUnauthorized: true });
    });

    it('strips ssl-affecting URL params (ssl, percent-encoded) so they cannot downgrade the policy', () => {
      // ?sslmode=verify-full&ssl=0 would otherwise connect in plaintext.
      const a = loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/db?sslmode=verify-full&ssl=0' });
      expect(a.connectionString).toBe('postgres://u:p@h:5432/db');
      expect(a.ssl).toEqual({ rejectUnauthorized: true });
      // percent-encoded name is matched by its decoded form.
      const b = loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/db?sslmode=require&%73sl=0' });
      expect(b.connectionString).toBe('postgres://u:p@h:5432/db');
      // sslcert/sslkey/sslrootcert are removed (URL certs unsupported; use PG_SSL_CA).
      const c = loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/db?sslmode=require&sslrootcert=/x&sslcert=/y' });
      expect(c.connectionString).toBe('postgres://u:p@h:5432/db');
      // sslnegotiation=direct would otherwise make pg resolve ssl to bare `true`, dropping the CA object.
      const d = loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/db?sslmode=verify-full&sslnegotiation=direct' });
      expect(d.connectionString).toBe('postgres://u:p@h:5432/db');
      expect(d.ssl).toEqual({ rejectUnauthorized: true });
    });

    it('strips sslmode from the connection string so pg URL parsing cannot override the ssl object', () => {
      // pg gives parsed URL params precedence over an explicit ssl option:
      // left in place, sslmode=require would flip to FULL certificate
      // verification (and break the README RDS one-liner).
      const bare = loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/db?sslmode=require' });
      expect(bare.connectionString).toBe('postgres://u:p@h:5432/db');
      expect(bare.ssl).toEqual({ rejectUnauthorized: false });

      const mixed = loadConfig({
        DATABASE_URL: 'postgres://u:p@h:5432/db?sslmode=require&application_name=mcp',
      });
      expect(mixed.connectionString).toBe('postgres://u:p@h:5432/db?application_name=mcp');
    });

    it('prefer and allow encrypt without verifying the certificate (allow is aliased to prefer)', () => {
      expect(loadConfig({ PG_HOST: 'h', PG_SSLMODE: 'prefer' }).ssl).toEqual({ rejectUnauthorized: false });
      expect(loadConfig({ PG_HOST: 'h', PG_SSLMODE: 'allow' }).ssl).toEqual({ rejectUnauthorized: false });
    });

    it('verify-ca with a CA verifies the chain but skips the hostname check (libpq)', () => {
      const caPath = join(scratch, 'verifyca.pem');
      writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n');
      const ssl = loadConfig({ PG_HOST: 'h', PG_SSLMODE: 'verify-ca', PG_SSL_CA: caPath }).ssl as {
        ca?: string;
        checkServerIdentity?: unknown;
      };
      expect(ssl.ca).toContain('BEGIN CERTIFICATE');
      expect(typeof ssl.checkServerIdentity).toBe('function'); // hostname check disabled, unlike verify-full
      expect((ssl as { rejectUnauthorized?: boolean }).rejectUnauthorized).toBe(true); // pinned against a global bypass
    });

    it('verify-ca without a CA is refused (a CA is required to verify anything)', () => {
      expect(() => loadConfig({ PG_HOST: 'h', PG_SSLMODE: 'verify-ca' })).toThrow();
    });

    it('throws on an unrecognized sslmode instead of silently connecting without TLS', () => {
      expect(() => loadConfig({ PG_HOST: 'h', PG_SSLMODE: 'verify_full' })).toThrow(/unrecognized sslmode/);
      expect(() => loadConfig({ DATABASE_URL: 'postgres://u:p@h/db?sslmode=requir' })).toThrow(
        /unrecognized sslmode/
      );
    });

    it('PG_SSL_CA alone implies verify-full (CA loaded, hostname still checked)', () => {
      const caPath = join(scratch, 'implied-ca.pem');
      writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n');
      const ssl = loadConfig({ PG_HOST: 'h', PG_SSL_CA: caPath }).ssl as {
        ca?: string;
        checkServerIdentity?: unknown;
      };
      expect(ssl.ca).toContain('BEGIN CERTIFICATE');
      expect(ssl.checkServerIdentity).toBeUndefined(); // verify-full keeps the hostname check
    });
  });
});

describe('loadConfig: SSH tunnel (PG_SSH_*)', () => {
  it('leaves ssh undefined when PG_SSH_HOST is not set (direct connection)', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://u:p@db/app' }).ssh).toBeUndefined();
  });

  it('enables the tunnel on PG_SSH_HOST alone, defaulting the port to 22', () => {
    const { ssh } = loadConfig({ DATABASE_URL: 'postgres://u:p@db/app', PG_SSH_HOST: 'bastion' });
    expect(ssh).toEqual({
      host: 'bastion',
      port: 22,
      user: undefined,
      privateKeyPath: undefined,
      passphrase: undefined,
      agent: undefined,
      password: undefined,
      fingerprint: undefined,
      keepaliveIntervalMs: 15000,
    });
  });

  it('maps every PG_SSH_* field', () => {
    const { ssh } = loadConfig({
      DATABASE_URL: 'postgres://u:p@db/app',
      PG_SSH_HOST: 'bastion',
      PG_SSH_PORT: '2222',
      PG_SSH_USER: 'jump',
      PG_SSH_PRIVATE_KEY: '/keys/id_ed25519',
      PG_SSH_PASSPHRASE: 'secret',
      PG_SSH_AGENT: 'true',
      PG_SSH_PASSWORD: 'pw',
      PG_SSH_FINGERPRINT: 'SHA256:abc',
      PG_SSH_KEEPALIVE_INTERVAL: '30000',
    });
    expect(ssh).toEqual({
      host: 'bastion',
      port: 2222,
      user: 'jump',
      privateKeyPath: '/keys/id_ed25519',
      passphrase: 'secret',
      agent: 'true',
      password: 'pw',
      fingerprint: 'SHA256:abc',
      keepaliveIntervalMs: 30000,
    });
  });

  it('falls back to port 22 for junk PG_SSH_PORT and throws for an out-of-range one', () => {
    expect(loadConfig({ PG_SSH_HOST: 'b', PG_SSH_PORT: 'abc' }).ssh?.port).toBe(22);
    expect(() => loadConfig({ PG_SSH_HOST: 'b', PG_SSH_PORT: '70000' })).toThrow(/invalid PG_SSH_PORT/);
  });
});

describe('baseClientOptions', () => {
  it('carries the timeouts and pipeline flag, and includes ssl only when a policy is set', () => {
    const withSsl = baseClientOptions(loadConfig({ DATABASE_URL: 'postgres://u:p@h/d?sslmode=require', PG_STATEMENT_TIMEOUT: '5000', PG_CONNECT_TIMEOUT: '3000' }));
    expect(withSsl).toMatchObject({ connectionTimeoutMillis: 3000, query_timeout: 8000, pipeline: true, ssl: { rejectUnauthorized: false } });
    const noSsl = baseClientOptions(loadConfig({ DATABASE_URL: 'postgres://u:p@h/d' }));
    expect('ssl' in noSsl).toBe(false);
  });
});

describe('resolveClientOptions', () => {
  it('preserves full connection-string settings (application_name, options/search_path) and applies ssl', () => {
    const opts = resolveClientOptions(loadConfig({ DATABASE_URL: 'postgres://u:p@db.example.com:5433/app?application_name=mcp&options=-c%20search_path%3Dapp&sslmode=require' }));
    expect(opts).toMatchObject({
      host: 'db.example.com',
      port: 5433,
      user: 'u',
      password: 'p',
      database: 'app',
      application_name: 'mcp',
      options: '-c search_path=app',
      pipeline: true,
      ssl: { rejectUnauthorized: false },
    });
  });

  it('uses the PG_* fields when there is no connection string', () => {
    const opts = resolveClientOptions(loadConfig({ PG_HOST: 'h', PG_PORT: '6543', PG_USER: 'x', PG_PASSWORD: 'y', PG_DATABASE: 'd' }));
    expect(opts).toMatchObject({ host: 'h', port: 6543, user: 'x', database: 'd' });
  });

  it('strips the brackets pg-connection-string keeps on an IPv6 literal so pg can resolve it', () => {
    expect(resolveClientOptions(loadConfig({ DATABASE_URL: 'postgres://u:p@[::1]:5434/db' })).host).toBe('::1');
    // A bracketed non-IP token is left untouched (only real IPv6 literals are unwrapped).
    expect(resolveClientOptions({ ...loadConfig({}), host: '[not-an-ip]' }).host).toBe('[not-an-ip]');
    // A plain hostname passes through, and an absent host stays undefined.
    expect(resolveClientOptions(loadConfig({ PG_HOST: 'plain.example' })).host).toBe('plain.example');
    expect(resolveClientOptions(loadConfig({ PG_USER: 'u' })).host).toBeUndefined();
  });

  it('rejects an out-of-range port (URL ?port= included) before any connect', () => {
    expect(() => resolveClientOptions(loadConfig({ DATABASE_URL: 'postgres://u:p@127.0.0.1/db?port=999999' }))).toThrow(/invalid port/);
  });
});

describe('defaultClientFactory', () => {
  // pg.Client exposes what it parsed as connectionParameters; nothing connects here.
  const paramsOf = (cfg: Parameters<typeof defaultClientFactory>[0]) =>
    (defaultClientFactory(cfg) as unknown as { connectionParameters: Record<string, unknown> }).connectionParameters;

  it('prefers the connection string and passes the ssl policy alongside it', () => {
    const cfg = loadConfig({ DATABASE_URL: 'postgres://u:p@db.example.com:5433/app?sslmode=require' });
    const params = paramsOf(cfg);
    expect(params).toMatchObject({ host: 'db.example.com', port: 5433, user: 'u', database: 'app' });
    expect(params.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('falls back to the PG_* fields, leaving ssl to pg defaults when no policy is set', () => {
    const cfg = loadConfig({ PG_HOST: 'h', PG_PORT: '6543', PG_USER: 'u', PG_PASSWORD: 'p', PG_DATABASE: 'd' });
    const params = paramsOf(cfg);
    expect(params).toMatchObject({ host: 'h', port: 6543, user: 'u', database: 'd' });
    expect(params.ssl).toBeFalsy();
  });

  it('passes connectionTimeoutMillis so a stalled connect cannot hang forever', () => {
    const client = defaultClientFactory(loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d', PG_CONNECT_TIMEOUT: '3000' }));
    expect((client as unknown as { _connectionTimeoutMillis: number })._connectionTimeoutMillis).toBe(3000);
  });

  it('sets query_timeout above statement_timeout as a client-side deadline for a stalled socket', () => {
    // server-side statement_timeout cannot fire when the server never answers; query_timeout can.
    const client = defaultClientFactory(
      loadConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d', PG_STATEMENT_TIMEOUT: '5000', PG_CONNECT_TIMEOUT: '3000' })
    );
    expect((client as unknown as { connectionParameters: { query_timeout: number } }).connectionParameters.query_timeout).toBe(8000);
  });

  it('throws for a DATABASE_URL ?port= outside 1-65535, before any connect (no ERR_SOCKET_BAD_PORT crash)', () => {
    // pg parses ?port= into connectionParameters.port, bypassing PG_PORT/connect_db checks.
    expect(() => defaultClientFactory(loadConfig({ DATABASE_URL: 'postgres://u:p@127.0.0.1/db?port=999999' }))).toThrow(/invalid port/);
  });
});
