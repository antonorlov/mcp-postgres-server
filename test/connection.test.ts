// Database lifecycle on a fake pg client: lazy connect, the dropped-socket error handler, cleanup on
// connect failure, connect_db swap-with-rollback - failure modes awkward to provoke against a real server.
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type pg from 'pg';
import { createApp, createDatabase, createServer, loadConfig, type Connection, type Connector, type ServerConfig } from '../src/index.js';

interface FakeOptions {
  connectError?: Error;
  endError?: Error;
  rollbackError?: Error;
  beginError?: Error;
  queryError?: Error; // thrown for a user query whose text contains "will_fail"
  settingsError?: Error; // thrown while applying session settings (the set_config query)
  superuser?: 'on' | 'off' | 'throw';
}

class FakeClient extends EventEmitter {
  readonly queries: string[] = [];
  readonly calls: Array<{ text: string; values: unknown[] }> = [];
  ended = false;
  connectCount = 0;
  private tx: 'I' | 'T' | 'E' = 'I'; // ReadyForQuery status, like a real pg client
  constructor(private readonly opts: FakeOptions = {}) {
    super();
  }
  getTransactionStatus(): string {
    return this.tx;
  }
  async connect(): Promise<void> {
    this.connectCount++;
    // A real pg client rejects a second connect - the contract getClient must not violate.
    if (this.connectCount > 1) throw new Error('Client has already been connected. You cannot reuse a client.');
    if (this.opts.connectError) throw this.opts.connectError;
  }
  async end(): Promise<void> {
    this.ended = true;
    if (this.opts.endError) throw this.opts.endError;
  }
  async query(cfg: string | { text: string; values?: unknown[] }, values: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number; command: string }> {
    const text = typeof cfg === 'string' ? cfg : cfg.text;
    this.queries.push(text);
    this.calls.push({ text, values: typeof cfg === 'string' ? values : cfg.values ?? [] });
    if (/^\s*BEGIN/i.test(text)) this.tx = 'T';
    else if (/^\s*(ROLLBACK|COMMIT|END|ABORT)/i.test(text)) this.tx = 'I';
    if (this.opts.settingsError && /set_config/.test(text)) throw this.opts.settingsError;
    if (text === 'BEGIN READ ONLY' && this.opts.beginError) throw this.opts.beginError;
    if (text === 'ROLLBACK' && this.opts.rollbackError) throw this.opts.rollbackError;
    if (this.opts.queryError && /will_fail/.test(text)) {
      this.tx = 'E'; // a failed statement leaves the transaction aborted
      throw this.opts.queryError;
    }
    if (/is_superuser/.test(text)) {
      if (this.opts.superuser === 'throw') throw new Error('permission denied for current_setting');
      return { rows: [{ is_superuser: this.opts.superuser ?? 'off' }], rowCount: 1, command: 'SELECT' };
    }
    return { rows: [{ ok: 1 }], rowCount: 1, command: 'SELECT' };
  }
}

// Connect a fake per the Connector contract: on failure end the half-open client (swallowing that
// error) and rethrow the original, so the connect error - not a cleanup error - propagates.
async function connectFake(client: FakeClient): Promise<Connection> {
  const c = client as unknown as pg.Client;
  try {
    await c.connect();
  } catch (err) {
    await c.end().catch(() => undefined);
    throw err;
  }
  return { client: c, close: () => client.end().catch(() => undefined) };
}

// Hands out pre-built fakes in order and records the config it was given; close() ends the fake.
function factoryOf(...clients: FakeClient[]): { connector: Connector; configs: ServerConfig[] } {
  const configs: ServerConfig[] = [];
  const connector: Connector = {
    connect: (cfg) => {
      configs.push(cfg);
      const next = clients.shift();
      if (!next) throw new Error('connector called more times than expected');
      return connectFake(next);
    },
  };
  return { connector, configs };
}

// A connector backed by a single fake client.
function connectorFor(client: FakeClient): Connector {
  return { connect: () => connectFake(client) };
}

// Connects the fake but hands back a custom close(), for probing teardown (async cleanup that may reject).
function connectorWithClose(client: FakeClient, close: () => Promise<void>): Connector {
  return {
    connect: async () => {
      await (client as unknown as pg.Client).connect();
      return { client: client as unknown as pg.Client, close };
    },
  };
}

async function openServer(config: ServerConfig, connector: Connector) {
  const server = createServer(config, connector);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new McpClient({ name: 'connection-test', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0].text;
    return { isError: result.isError === true, payload: JSON.parse(text) as Record<string, unknown> };
  };
  return {
    call,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const URL = 'postgres://u:p@db.example.com:5432/app';

describe('getClient: nothing configured', () => {
  it('returns an isError result naming every way to configure, without calling the connector', async () => {
    const { connector, configs } = factoryOf();
    const { call, close } = await openServer(loadConfig({}), connector);
    try {
      const r = await call('query', { sql: 'SELECT 1' });
      expect(r.isError).toBe(true);
      expect(r.payload.message).toMatch(/no database configured/);
      expect(r.payload.message).toMatch(/DATABASE_URL/);
      expect(r.payload.message).toMatch(/PG_ENABLE_RUNTIME_CONNECT/);
      expect(configs).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it.each([
    ['PG_HOST', { PG_HOST: 'h' }],
    ['PG_USER', { PG_USER: 'u' }],
    ['PG_DATABASE', { PG_DATABASE: 'd' }],
  ])('any single %s is enough to attempt a connection', async (_name, env) => {
    const { connector, configs } = factoryOf(new FakeClient());
    const { call, close } = await openServer(loadConfig(env), connector);
    try {
      const r = await call('query', { sql: 'SELECT 1' });
      expect(r.isError).toBe(false);
      expect(configs).toHaveLength(1);
    } finally {
      await close();
    }
  });
});

describe('Database read routing', () => {
  it('read-only mode wraps the read in a rolled-back READ ONLY transaction, params bound as values', async () => {
    const fake = new FakeClient();
    const db = createDatabase(loadConfig({ DATABASE_URL: URL }), connectorFor(fake));
    await db.query('SELECT 1'); // one-time connection setup
    fake.calls.length = 0;
    const value = "'; COMMIT; DELETE FROM users; --";
    const result = await db.query('SELECT $1 AS value', [value]);
    expect(result.ok).toBe(true);
    expect(fake.calls.map((c) => c.text)).toEqual(['BEGIN READ ONLY', 'SELECT $1 AS value', 'ROLLBACK']);
    // the value is bound, never spliced into the SQL text.
    expect(fake.calls[1]).toEqual({ text: 'SELECT $1 AS value', values: [value] });
    await db.close();
  });

  it('write mode (PG_ALLOW_WRITE=true) sends the read directly, no transaction wrapping', async () => {
    const fake = new FakeClient();
    const db = createDatabase(loadConfig({ DATABASE_URL: URL, PG_ALLOW_WRITE: 'true' }), connectorFor(fake));
    await db.query('SELECT 1'); // one-time connection setup
    fake.calls.length = 0;
    await db.query('SELECT id FROM users WHERE id = $1', [7]);
    expect(fake.calls.map((c) => c.text)).toEqual(['SELECT id FROM users WHERE id = $1']);
    await db.close();
  });

  it('read-only mode refuses execute without opening a connection or sending the write', async () => {
    const connect = vi.fn();
    const db = createDatabase(loadConfig({ DATABASE_URL: URL }), { connect }); // read-only by default
    const r = await db.execute('INSERT INTO t (x) VALUES (1)');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(String(r.error.message)).toMatch(/read-only|PG_ALLOW_WRITE/);
    expect(connect).not.toHaveBeenCalled(); // never even connected
    await db.close();
  });

  it('does not dispatch the read when BEGIN READ ONLY fails', async () => {
    const fake = new FakeClient({ beginError: new Error('cannot begin') });
    const db = createDatabase(loadConfig({ DATABASE_URL: URL }), connectorFor(fake));
    expect((await db.query('SELECT id FROM users')).ok).toBe(false);
    expect(fake.queries).not.toContain('SELECT id FROM users');
    await db.close();
  });

  it('discards a connection left inside a transaction, so the next call is independent', async () => {
    const first = new FakeClient();
    const second = new FakeClient();
    const { connector } = factoryOf(first, second);
    const db = createDatabase(loadConfig({ DATABASE_URL: URL, PG_ALLOW_WRITE: 'true' }), connector);
    // A bare BEGIN leaves the connection in a transaction: reported as an error, not a false success.
    const begin = await db.execute('BEGIN');
    expect(begin.ok).toBe(false);
    if (!begin.ok) expect(begin.error.message).toMatch(/transaction control is not supported/);
    expect(first.ended).toBe(true); // discarded rather than reused
    // The next call reconnects on a fresh client - no leaked transaction state.
    const r = await db.query('SELECT 1');
    expect(r.ok).toBe(true);
    expect(second.queries).toContain('SELECT 1');
    await db.close();
  });

  it('discards a connection left in an aborted transaction (status E) after a failed statement', async () => {
    const first = new FakeClient({ queryError: Object.assign(new Error('boom'), { code: '25P02' }) });
    const second = new FakeClient();
    const { connector } = factoryOf(first, second);
    const db = createDatabase(loadConfig({ DATABASE_URL: URL, PG_ALLOW_WRITE: 'true' }), connector);
    const failed = await db.execute('will_fail');
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe('25P02'); // the real SQL error is preserved, not overridden
    expect(first.ended).toBe(true); // discarded, not reused
    expect((await db.query('SELECT 1')).ok).toBe(true); // fresh client
    await db.close();
  });
});

describe('getClient: connect failure', () => {
  it('ends the half-open client and reports the connect error', async () => {
    const fake = new FakeClient({ connectError: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
    const { connector } = factoryOf(fake);
    const { call, close } = await openServer(loadConfig({ DATABASE_URL: URL }), connector);
    try {
      const r = await call('query', { sql: 'SELECT 1' });
      expect(r.isError).toBe(true);
      expect(r.payload.code).toBe('ECONNREFUSED');
      expect(r.payload.hint).toMatch(/PG_HOST/);
      expect(fake.ended).toBe(true);
    } finally {
      await close();
    }
  });

  it('still reports the connect error when end() itself throws', async () => {
    const fake = new FakeClient({ connectError: new Error('refused'), endError: new Error('socket gone') });
    const { connector } = factoryOf(fake);
    const { call, close } = await openServer(loadConfig({ DATABASE_URL: URL }), connector);
    try {
      const r = await call('query', { sql: 'SELECT 1' });
      expect(r.isError).toBe(true);
      expect(r.payload.message).toBe('refused');
    } finally {
      await close();
    }
  });
});

describe('connector lifecycle contract', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not reconnect a client the connector already connected (connect exactly once)', async () => {
    const fake = new FakeClient();
    const db = createDatabase(loadConfig({ DATABASE_URL: URL }), connectorFor(fake));
    const r = await db.query('SELECT 1'); // getClient must NOT call connect() a second time
    expect(r.ok).toBe(true); // else the fake throws "already been connected"
    await db.query('SELECT 2'); // reuses the live connection
    expect(fake.connectCount).toBe(1);
    await db.close();
  });

  it('reports the setup error even when the ensuing cleanup fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fake = new FakeClient({ settingsError: new Error('cannot set statement_timeout') });
    // close() rejects: it must not replace the original setup error.
    const db = createDatabase(loadConfig({ DATABASE_URL: URL }), connectorWithClose(fake, () => Promise.reject(new Error('tunnel close failed'))));
    const r = await db.query('SELECT 1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe('cannot set statement_timeout');
    await db.close();
  });

  it('awaits an error-triggered teardown at close() and logs its failure instead of throwing', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fake = new FakeClient();
    let closeFinished = false;
    // Async cleanup that only settles on a later macrotask, then rejects (like an SSH tunnel teardown).
    const db = createDatabase(
      loadConfig({ DATABASE_URL: URL }),
      connectorWithClose(fake, () => new Promise((_, reject) => setImmediate(() => {
        closeFinished = true;
        reject(new Error('tunnel close failed'));
      })))
    );
    await db.query('SELECT 1'); // opens the connection
    fake.emit('error', new Error('server closed the connection unexpectedly')); // out-of-band drop
    await db.close(); // must await the in-flight teardown, not exit mid-cleanup
    expect(closeFinished).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/connection cleanup failed: tunnel close failed/));
  });
});

describe('session settings', () => {
  afterEach(() => vi.restoreAllMocks());

  it('applies the timeout and warns when connected as a superuser', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fake = new FakeClient({ superuser: 'on' });
    const { connector } = factoryOf(fake);
    const { call, close } = await openServer(loadConfig({ DATABASE_URL: URL, PG_STATEMENT_TIMEOUT: '1500' }), connector);
    try {
      await call('query', { sql: 'SELECT 1' });
      // statement_timeout and idle_in_transaction_session_timeout are set via a parameterized
      // set_config, not interpolated SQL.
      expect(fake.calls).toContainEqual({
        text: 'SELECT set_config($1, $3, false), set_config($2, $3, false)',
        values: ['statement_timeout', 'idle_in_transaction_session_timeout', '1500'],
      });
      // Read-only is enforced by the engine (BEGIN READ ONLY), never as a session-level
      // SET - a session default would leak across PgBouncer transaction-pooled backends.
      expect(fake.queries.some((q) => /SET default_transaction_read_only/.test(q))).toBe(false);
      await call('query', { sql: 'SELECT id FROM users' });
      expect(fake.queries).toContain('BEGIN READ ONLY');
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/connected as a superuser/));
    } finally {
      await close();
    }
  });

  it('treats the superuser check as advisory: a failing check does not fail the connection', async () => {
    const fake = new FakeClient({ superuser: 'throw' });
    const { connector } = factoryOf(fake);
    const { call, close } = await openServer(loadConfig({ DATABASE_URL: URL }), connector);
    try {
      const r = await call('query', { sql: 'SELECT 1' });
      expect(r.isError).toBe(false);
    } finally {
      await close();
    }
  });

  it('never sets a session read-only flag, and skips the superuser check in write mode', async () => {
    const fake = new FakeClient({ superuser: 'on' });
    const { connector } = factoryOf(fake);
    const { call, close } = await openServer(loadConfig({ DATABASE_URL: URL, PG_ALLOW_WRITE: 'true' }), connector);
    try {
      await call('query', { sql: 'SELECT 1' });
      expect(fake.queries.some((q) => /SET default_transaction_read_only/.test(q))).toBe(false);
      expect(fake.queries.some((q) => /is_superuser/.test(q))).toBe(false);
    } finally {
      await close();
    }
  });
});

describe('dropped connection', () => {
  afterEach(() => vi.restoreAllMocks());

  it("an 'error' event logs, drops the client, and the next call reconnects", async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const first = new FakeClient();
    const second = new FakeClient();
    const { connector, configs } = factoryOf(first, second);
    const { call, close } = await openServer(loadConfig({ DATABASE_URL: URL }), connector);
    try {
      await call('query', { sql: 'SELECT 1' });
      expect(configs).toHaveLength(1);
      first.emit('error', new Error('server closed the connection unexpectedly'));
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/connection error: server closed/));
      const r = await call('query', { sql: 'SELECT 1' });
      expect(r.isError).toBe(false);
      expect(configs).toHaveLength(2);
    } finally {
      await close();
    }
  });

  it("an 'error' event from a client that was already replaced does not drop the live one", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const first = new FakeClient();
    const second = new FakeClient();
    const { connector, configs } = factoryOf(first, second);
    const env = { DATABASE_URL: URL, PG_ENABLE_RUNTIME_CONNECT: 'true' };
    const { call, close } = await openServer(loadConfig(env), connector);
    try {
      await call('query', { sql: 'SELECT 1' });
      await call('connect_db', { host: 'other', user: 'u', password: 'p', database: 'd' });
      expect(first.ended).toBe(true);
      first.emit('error', new Error('late error from the old socket'));
      await call('query', { sql: 'SELECT 1' });
      expect(configs).toHaveLength(2); // no third client: `second` stayed live
    } finally {
      await close();
    }
  });
});

describe('connect_db (reconnect)', () => {
  it('as the first call: no previous client to close, defaults the port, re-applies session settings', async () => {
    const fake = new FakeClient();
    const { connector, configs } = factoryOf(fake);
    const env = { DATABASE_URL: URL, PG_ENABLE_RUNTIME_CONNECT: 'true' };
    const { call, close } = await openServer(loadConfig(env), connector);
    try {
      const r = await call('connect_db', { host: 'other', user: 'u2', password: 'p2', database: 'd2' });
      expect(r.isError).toBe(false);
      expect(r.payload).toMatchObject({ host: 'other', database: 'd2' });
      expect(configs[0]).toMatchObject({ host: 'other', port: 5432, user: 'u2', database: 'd2', readOnly: true });
      expect(configs[0].connectionString).toBeUndefined();
      // Session settings re-applied on the new connection (statement_timeout);
      // read-only is per-query, never a leaky session-level SET.
      expect(fake.calls.some((c) => c.values[0] === 'statement_timeout')).toBe(true);
      expect(fake.queries.some((q) => /SET default_transaction_read_only/.test(q))).toBe(false);
    } finally {
      await close();
    }
  });

  it('honours an explicit port and closes the previous client', async () => {
    const first = new FakeClient();
    const second = new FakeClient();
    const { connector, configs } = factoryOf(first, second);
    const env = { DATABASE_URL: URL, PG_ENABLE_RUNTIME_CONNECT: 'true' };
    const { call, close } = await openServer(loadConfig(env), connector);
    try {
      await call('query', { sql: 'SELECT 1' });
      const r = await call('connect_db', { host: 'other', port: 6543, user: 'u', password: 'p', database: 'd' });
      expect(r.isError).toBe(false);
      expect(first.ended).toBe(true);
      expect(configs[1].port).toBe(6543);
    } finally {
      await close();
    }
  });

  it('on failure rolls back to the previous target, even when closing the old client throws', async () => {
    const first = new FakeClient({ endError: new Error('already gone') });
    const bad = new FakeClient({ connectError: Object.assign(new Error('auth failed'), { code: '28P01' }) });
    const retry = new FakeClient();
    const { connector, configs } = factoryOf(first, bad, retry);
    const env = { DATABASE_URL: URL, PG_ENABLE_RUNTIME_CONNECT: 'true' };
    const { call, close } = await openServer(loadConfig(env), connector);
    try {
      await call('query', { sql: 'SELECT 1' });
      const r = await call('connect_db', { host: 'bad', user: 'u', password: 'p', database: 'd' });
      expect(r.isError).toBe(true);
      expect(r.payload.code).toBe('28P01');
      expect(r.payload.hint).toMatch(/PG_USER/);
      // The next call reconnects to the ORIGINAL target, not the bad one.
      const again = await call('query', { sql: 'SELECT 1' });
      expect(again.isError).toBe(false);
      expect(configs[2].connectionString).toBe(URL);
      expect(configs[2].host).toBeUndefined();
    } finally {
      await close();
    }
  });

  // Sibling of the PG_PORT range check: pg wraps an out-of-range port to a
  // random one, so the connect would hang the whole queue without this guard.
  it.each([999999, 0, -1, 70000])('rejects an out-of-range connect_db port %i without touching the connector', async (port) => {
    const first = new FakeClient();
    const { connector, configs } = factoryOf(first);
    const env = { DATABASE_URL: URL, PG_ENABLE_RUNTIME_CONNECT: 'true' };
    const { call, close } = await openServer(loadConfig(env), connector);
    try {
      await call('query', { sql: 'SELECT 1' }); // opens `first`
      const r = await call('connect_db', { host: 'h', port, user: 'u', password: 'p', database: 'd' });
      expect(r.isError).toBe(true);
      expect(r.payload.message).toMatch(/invalid port/);
      expect(configs).toHaveLength(1); // no second client was ever constructed
      const again = await call('query', { sql: 'SELECT 1' }); // old connection still serves
      expect(again.isError).toBe(false);
    } finally {
      await close();
    }
  });

  it('server shutdown closes the database client (no leaked session)', async () => {
    const fake = new FakeClient();
    const { connector } = factoryOf(fake);
    const { call, close } = await openServer(loadConfig({ DATABASE_URL: URL }), connector);
    await call('query', { sql: 'SELECT 1' }); // opens `fake`
    expect(fake.ended).toBe(false);
    await close(); // client.close() + server.close() -> conn.close()
    expect(fake.ended).toBe(true);
  });
});

describe('Database.query rollback failure', () => {
  const cfg = () => loadConfig({ DATABASE_URL: URL });

  it('reports failure and discards the client when the read rollback fails', async () => {
    const poisoned = new FakeClient({ rollbackError: new Error('rollback failed') });
    const fresh = new FakeClient();
    const { connector, configs } = factoryOf(poisoned, fresh);
    const db = createDatabase(cfg(), connector);

    const r = await db.query('SELECT id FROM users');
    expect(r.ok).toBe(false); // not a maybe-tampered success
    expect(configs).toHaveLength(1);
    expect(poisoned.ended).toBe(true); // discarded client was closed, not leaked

    // The poisoned client was discarded: the next call builds a fresh one.
    const again = await db.query('SELECT 1');
    expect(again.ok).toBe(true);
    expect(configs).toHaveLength(2);
  });

  it('reports the query error (not the rollback error) when both fail, and discards the client', async () => {
    const queryErr = Object.assign(new Error('boom'), { code: '42P01' });
    const poisoned = new FakeClient({ queryError: queryErr, rollbackError: new Error('rollback failed') });
    const db = createDatabase(cfg(), connectorFor(poisoned));
    const r = await db.query('SELECT will_fail');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('42P01'); // original query error wins over the rollback error
    expect(poisoned.ended).toBe(true); // client discarded, not leaked
  });
});

describe('createApp.close', () => {
  it('awaits database cleanup, not only server.close', async () => {
    const fake = new FakeClient();
    const app = createApp(loadConfig({ DATABASE_URL: URL }), connectorFor(fake));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new McpClient({ name: 'app-close-test', version: '0.0.0' });
    await app.server.connect(serverTransport);
    await mcp.connect(clientTransport);
    await mcp.callTool({ name: 'query', arguments: { sql: 'SELECT 1' } }); // lazily opens the db client
    await app.close();
    expect(fake.ended).toBe(true); // close() resolved only after db cleanup ran
    await mcp.close().catch(() => undefined);
  });
});

describe('Database.close', () => {
  const cfg = () => loadConfig({ DATABASE_URL: URL });

  it('ends the client, is idempotent, and swallows an end() that throws', async () => {
    const fake = new FakeClient({ endError: new Error('socket gone') });
    const db = createDatabase(cfg(), connectorFor(fake));
    await db.query('SELECT 1'); // opens the client
    await db.close(); // end() throws internally; must not reject
    expect(fake.ended).toBe(true);
    await db.close(); // idempotent: nothing left to end
  });

  it('close() with no open client is a no-op', async () => {
    const db = createDatabase(cfg(), connectorFor(new FakeClient()));
    await expect(db.close()).resolves.toBeUndefined();
  });
});

describe('Database does not expose mutable configuration', () => {
  it('has no config surface a caller could mutate to flip readOnly', () => {
    const db = createDatabase(loadConfig({ DATABASE_URL: URL }), connectorFor(new FakeClient()));
    // The concrete pg.Client, the target, and the read-only policy stay inside
    // the implementation; the interface is domain operations only.
    expect(Object.keys(db).sort()).toEqual(
      ['close', 'describeTable', 'execute', 'listSchemas', 'listTables', 'query', 'retarget'].sort()
    );
    expect((db as Record<string, unknown>).config).toBeUndefined();
  });
});
