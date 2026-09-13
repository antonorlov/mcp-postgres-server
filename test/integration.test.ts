// Integration tests against a REAL Postgres via the MCP SDK client. Skipped unless PG_TEST_URL is set
// (CI: postgres:16-alpine). Assert read-only holds: execute is gated, and every read runs in a
// rolled-back BEGIN READ ONLY so a write hidden in a view/function/escaping fails with 25006. The
// real boundary is the connecting role (see SECURITY.md).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { classifyError, createServer, defaultConnector, loadConfig, type Connector } from '../src/index.js';

const PG_TEST_URL = process.env.PG_TEST_URL;
const TABLE = 'mcp_v2_integration_test';
const SEQ = 'mcp_v2_integration_test_seq';
const READ_FUNCTION = 'mcp_v2_integration_hidden_write';
const READ_VIEW = 'mcp_v2_integration_read_view';
// A SELECT-only role, set up the way SECURITY.md tells users to - the
// configuration the server is actually meant to run under.
const RO_ROLE = 'mcp_v2_integration_readonly';
const RO_PASSWORD = 'mcp_v2_integration_readonly';

// PG_TEST_URL with a different login, for connecting as a specific role.
function urlAs(user: string, password: string): string {
  const url = new URL(PG_TEST_URL!);
  url.username = user;
  url.password = password;
  return url.toString();
}

describe.skipIf(!PG_TEST_URL)('integration: real Postgres via PG_TEST_URL', () => {
  let admin: pg.Client;
  const spawned: pg.Client[] = [];

  // Wrap the real connector so the test can track and close every connection the server opens.
  const trackingConnector: Connector = {
    async connect(cfg) {
      const conn = await defaultConnector.connect(cfg);
      spawned.push(conn.client);
      return conn;
    },
  };

  async function openServer(extraEnv: Record<string, string> = {}, databaseUrl = PG_TEST_URL) {
    const config = loadConfig({ DATABASE_URL: databaseUrl, ...extraEnv });
    const server = createServer(config, trackingConnector);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new McpClient({ name: 'integration-test', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return {
      client,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }

  function textOf(result: unknown): string {
    const { content } = result as { content?: Array<{ type: string; text: string }> };
    expect(content?.[0]?.type).toBe('text');
    return content![0].text;
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: PG_TEST_URL });
    await admin.connect();
    await admin.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await admin.query(`CREATE TABLE ${TABLE} (id int PRIMARY KEY, name text NOT NULL)`);
    await admin.query(
      `INSERT INTO ${TABLE} (id, name) VALUES (1, 'ada'), (2, 'brian'), (3, 'chandra')`
    );
    await admin.query(`DROP SEQUENCE IF EXISTS ${SEQ}`);
    await admin.query(`CREATE SEQUENCE ${SEQ}`);
    // A syntactically simple view read hides a write-capable function. It changes no rows.
    await admin.query(`CREATE OR REPLACE FUNCTION ${READ_FUNCTION}() RETURNS int LANGUAGE plpgsql AS $$ BEGIN DELETE FROM ${TABLE} WHERE false; RETURN 42; END $$`);
    await admin.query(`CREATE OR REPLACE VIEW ${READ_VIEW} AS SELECT ${READ_FUNCTION}() AS id`);

    // The least-privilege role from SECURITY.md: CONNECT + USAGE + SELECT, nothing else.
    await admin.query(`DROP OWNED BY ${RO_ROLE}`).catch(() => undefined); // role may not exist yet
    await admin.query(`DROP ROLE IF EXISTS ${RO_ROLE}`);
    await admin.query(`CREATE ROLE ${RO_ROLE} LOGIN PASSWORD '${RO_PASSWORD}'`);
    const { rows } = await admin.query<{ db: string }>('SELECT current_database() AS db');
    await admin.query(`GRANT CONNECT ON DATABASE "${rows[0].db}" TO ${RO_ROLE}`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${RO_ROLE}`);
    await admin.query(`GRANT SELECT ON ${TABLE} TO ${RO_ROLE}`);
  });

  afterAll(async () => {
    await admin.query(`DROP OWNED BY ${RO_ROLE}`); // revokes its grants so the role can go
    await admin.query(`DROP ROLE IF EXISTS ${RO_ROLE}`);
    await admin.query(`DROP VIEW IF EXISTS ${READ_VIEW}`);
    await admin.query(`DROP FUNCTION IF EXISTS ${READ_FUNCTION}()`);
    await admin.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await admin.query(`DROP SEQUENCE IF EXISTS ${SEQ}`);
    await admin.end();
  });

  afterEach(async () => {
    // End any pg clients the server spawned, whether or not the
    // implementation closed them itself.
    await Promise.allSettled(spawned.splice(0).map((c) => c.end()));
  });

  it('a view whose read hides a write is refused by the engine (25006)', async () => {
    expect((await admin.query(`SELECT id FROM ${READ_VIEW}`)).rows).toEqual([{ id: 42 }]);
    const { client, close } = await openServer();
    try {
      const result = await client.callTool({ name: 'query', arguments: { sql: `SELECT id FROM ${READ_VIEW}` } });
      expect(result.isError).toBe(true);
      expect(JSON.parse(textOf(result)).code).toBe('25006');
    } finally {
      await close();
    }
  });

  it('a write hidden by non-standard string escaping is still refused by the engine', async () => {
    const url = new URL(PG_TEST_URL!);
    url.searchParams.set('options', '-c standard_conforming_strings=off');
    const { client, close } = await openServer({}, url.toString());
    try {
      // With standard_conforming_strings=off the backslash changes how the string parses,
      // so on this backend the statement actually contains a nextval() call.
      const sql = String.raw`SELECT '\' AS a, ', nextval($$${SEQ}$$) --' AS b`;
      const result = await client.callTool({ name: 'query', arguments: { sql } });
      expect(result.isError).toBe(true);
      expect(JSON.parse(textOf(result)).code).toBe('25006');
    } finally {
      await close();
    }
  });

  it('binds parameters without interpreting their contents as SQL', async () => {
    const { client, close } = await openServer();
    try {
      const value = "'; COMMIT; DELETE FROM users; --";
      const result = await client.callTool({ name: 'query', arguments: { sql: 'SELECT $1 AS value', params: [value] } });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(textOf(result)).rows).toEqual([{ value }]);
    } finally {
      await close();
    }
  });

  it('query tool returns rows as compact JSON with rowCount and truncated:false', async () => {
    const { client, close } = await openServer();
    try {
      const result = await client.callTool({
        name: 'query',
        arguments: { sql: `SELECT id, name FROM ${TABLE} ORDER BY id` },
      });
      expect(result.isError).toBeFalsy();
      const text = textOf(result);
      expect(text).not.toContain('\n'); // compact JSON - no pretty-printing
      const payload = JSON.parse(text);
      expect(payload.rows).toEqual([
        { id: 1, name: 'ada' },
        { id: 2, name: 'brian' },
        { id: 3, name: 'chandra' },
      ]);
      expect(payload.rowCount).toBe(3);
      expect(payload.returnedRows).toBe(3);
      expect(payload.truncated).toBe(false);
    } finally {
      await close();
    }
  });

  it('read-only config: execute is registered but refuses writes without touching the database', async () => {
    const { client, close } = await openServer();
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('execute'); // discoverable
      expect(names).not.toContain('connect_db');

      const before = (await admin.query(`SELECT count(*)::int AS n FROM ${TABLE}`)).rows[0].n;
      const result = await client.callTool({
        name: 'execute',
        arguments: { sql: `INSERT INTO ${TABLE} (id, name) VALUES (99, 'mallory')` },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/read-only|PG_ALLOW_WRITE/); // names the fix
      const after = (await admin.query(`SELECT count(*)::int AS n FROM ${TABLE}`)).rows[0].n;
      expect(after).toBe(before);
    } finally {
      await close();
    }
  });

  it("read-only config: a write smuggled through query is refused by the engine's read-only transaction", async () => {
    const { client, close } = await openServer();
    try {
      const result = await client.callTool({
        name: 'query',
        arguments: { sql: `DELETE FROM ${TABLE}` },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/delete|read-only/i);

      const { rows } = await admin.query(`SELECT count(*)::int AS n FROM ${TABLE}`);
      expect(rows[0].n).toBe(3);
    } finally {
      await close();
    }
  });

  it('ENGINE layer: a read-only session rejects INSERT with SQLSTATE 25006', async () => {
    // The real boundary: prove the engine itself refuses a write in a read-only
    // transaction, independent of anything the server does client-side.
    const raw = new pg.Client({ connectionString: PG_TEST_URL });
    await raw.connect();
    try {
      await raw.query('SET default_transaction_read_only = on');
      const err: unknown = await raw
        .query(`INSERT INTO ${TABLE} (id, name) VALUES (99, 'mallory')`)
        .then(() => null)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      const pgErr = err as Error & { code?: string };
      expect(pgErr.code).toBe('25006');
      expect(pgErr.message).toMatch(/cannot execute INSERT in a read-only transaction/);

      // ...and classifyError describes it as a read-only transaction without presuming PG_ALLOW_WRITE
      // is the fix - here it is a server default (default_transaction_read_only), not our setting.
      const classified = classifyError(pgErr);
      expect(classified.hint).toMatch(/read-only/i);
      expect(classified.hint).not.toMatch(/PG_ALLOW_WRITE/);
    } finally {
      await raw.end();
    }
  });

  it('the set_config() read-only bypass is neutralized by the rolled-back transaction', async () => {
    // Historical bypass (set_config('default_transaction_read_only','off') then a write): here it runs
    // inside the per-query BEGIN READ ONLY and is reverted by ROLLBACK, never reaching the session.
    const { client, close } = await openServer();
    try {
      const bypass = await client.callTool({
        name: 'query',
        arguments: { sql: "SELECT set_config('default_transaction_read_only', 'off', false) AS v" },
      });
      expect(bypass.isError).toBeFalsy(); // it runs, but inside the rolled-back transaction

      // A write via a volatile function is still refused by the engine.
      const write = await client.callTool({
        name: 'query',
        arguments: { sql: `SELECT nextval('${SEQ}')` },
      });
      expect(write.isError).toBe(true);
      expect(JSON.parse(textOf(write)).code).toBe('25006');
    } finally {
      await close();
    }
  });

  it('a session setting changed inside a read query is reverted by the rollback', async () => {
    const { client, close } = await openServer({ PG_STATEMENT_TIMEOUT: '4000' });
    try {
      const changed = await client.callTool({
        name: 'query',
        arguments: { sql: "SELECT set_config('statement_timeout', '0', false) AS v" },
      });
      expect(changed.isError).toBeFalsy();
      const show = JSON.parse(
        textOf(await client.callTool({ name: 'query', arguments: { sql: 'SHOW statement_timeout' } }))
      );
      expect(show.rows).toEqual([{ statement_timeout: '4s' }]); // reverted, not 0
    } finally {
      await close();
    }
  });

  it('ENGINE layer: the extended protocol rejects multi-command strings outright', async () => {
    // The tools send user SQL with queryMode:'extended', which is now the only
    // multi-statement protection: Postgres itself refuses two commands in one call.
    const raw = new pg.Client({ connectionString: PG_TEST_URL });
    await raw.connect();
    try {
      const err: unknown = await raw
        .query({ text: 'SELECT 1; SELECT 2', values: [], queryMode: 'extended' } as pg.QueryConfig)
        .then(() => null)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/cannot insert multiple commands/);
    } finally {
      await raw.end();
    }
  });

  it('parallel first calls share ONE connection - no leaked client', async () => {
    const { client, close } = await openServer();
    try {
      const [a, b] = await Promise.all([
        client.callTool({ name: 'list_schemas', arguments: {} }),
        client.callTool({ name: 'list_schemas', arguments: {} }),
      ]);
      expect(a.isError).toBeFalsy();
      expect(b.isError).toBeFalsy();
      expect(spawned).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('size cap: a tiny PG_MAX_RESULT_BYTES truncates the result to fewer rows and says how to refine', async () => {
    const { client, close } = await openServer({ PG_MAX_RESULT_BYTES: '20' });
    try {
      const result = await client.callTool({
        name: 'query',
        arguments: { sql: `SELECT id FROM ${TABLE} ORDER BY id` },
      });
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(textOf(result));
      expect(payload.rowCount).toBe(3);
      expect(payload.returnedRows).toBeLessThan(3);
      expect(payload.returnedRows).toBeGreaterThanOrEqual(1);
      expect(payload.rows).toHaveLength(payload.returnedRows);
      expect(payload.truncated).toBe(true);
      expect(payload.hint).toMatch(/LIMIT|WHERE|columns/);
    } finally {
      await close();
    }
  });

  it('size cap: a single row larger than the budget returns 0 rows with truncated:true (does not bypass)', async () => {
    const { client, close } = await openServer({ PG_MAX_RESULT_BYTES: '100' });
    try {
      const result = await client.callTool({ name: 'query', arguments: { sql: "SELECT repeat('x', 5000) AS big" } });
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(textOf(result));
      expect(payload.rowCount).toBe(1);
      expect(payload.returnedRows).toBe(0);
      expect(payload.rows).toEqual([]);
      expect(payload.truncated).toBe(true);
      expect(payload.hint).toMatch(/budget|columns/);
    } finally {
      await close();
    }
  });

  it('bad SQL returns an isError result, not a thrown protocol error', async () => {
    const { client, close } = await openServer();
    try {
      // If the server threw McpError here, callTool would REJECT and this
      // await would throw - the assertion below proves it resolves instead
      // (spec 2025-11-25 / SEP-1303: execution errors are results).
      const result = await client.callTool({
        name: 'query',
        arguments: { sql: 'SELECT * FROM WHERE' },
      });
      expect(result.isError).toBe(true);
      const payload = JSON.parse(textOf(result));
      expect(payload.message).toMatch(/syntax/i);
    } finally {
      await close();
    }
  });

  it('unknown relation returns isError with the list_tables hint (42P01)', async () => {
    const { client, close } = await openServer();
    try {
      const result = await client.callTool({
        name: 'query',
        arguments: { sql: 'SELECT * FROM table_that_does_not_exist_xyz' },
      });
      expect(result.isError).toBe(true);
      const payload = JSON.parse(textOf(result));
      expect(payload.code).toBe('42P01');
      expect(payload.hint).toMatch(/list_tables/);
    } finally {
      await close();
    }
  });

  it('describe_table returns the typed column DTO', async () => {
    const { client, close } = await openServer();
    try {
      const result = await client.callTool({
        name: 'describe_table',
        arguments: { table: TABLE },
      });
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(textOf(result));
      const idColumn = payload.columns.find(
        (c: { column: string }) => c.column === 'id'
      );
      expect(idColumn).toMatchObject({ column: 'id', is_primary_key: true });
      expect(idColumn).toHaveProperty('type');
      expect(idColumn).toHaveProperty('nullable');
      expect(idColumn).toHaveProperty('default');
    } finally {
      await close();
    }
  });

  it('execute (write mode): runs INSERT and DELETE, returning rowCount and command', async () => {
    const { client, close } = await openServer({ PG_ALLOW_WRITE: 'true' });
    try {
      const inserted = await client.callTool({
        name: 'execute',
        arguments: { sql: `INSERT INTO ${TABLE} (id, name) VALUES ($1, $2)`, params: [4, 'dana'] },
      });
      expect(inserted.isError).toBeFalsy();
      expect(JSON.parse(textOf(inserted))).toEqual({ rowCount: 1, command: 'INSERT' });

      const deleted = await client.callTool({
        name: 'execute',
        arguments: { sql: `DELETE FROM ${TABLE} WHERE id = 4` },
      });
      expect(JSON.parse(textOf(deleted))).toEqual({ rowCount: 1, command: 'DELETE' });
    } finally {
      await close();
    }
  });

  it('list_schemas and list_tables: public by default, any schema on request', async () => {
    const { client, close } = await openServer();
    try {
      const schemas = JSON.parse(textOf(await client.callTool({ name: 'list_schemas', arguments: {} })));
      expect(schemas.schemas).toEqual(expect.arrayContaining(['public', 'pg_catalog']));

      const byDefault = JSON.parse(textOf(await client.callTool({ name: 'list_tables', arguments: {} })));
      expect(byDefault.tables).toContain(TABLE);

      const catalog = JSON.parse(
        textOf(await client.callTool({ name: 'list_tables', arguments: { schema: 'pg_catalog' } }))
      );
      expect(catalog.tables).toContain('pg_class');
      expect(catalog.tables).not.toContain(TABLE);
    } finally {
      await close();
    }
  });

  it('connect_db (runtime connect): swaps to a new target, and a failed swap leaves the old one working', async () => {
    const target = new URL(PG_TEST_URL!);
    const { client, close } = await openServer({ PG_ENABLE_RUNTIME_CONNECT: 'true' });
    try {
      const swapped = await client.callTool({
        name: 'connect_db',
        arguments: {
          host: target.hostname,
          port: Number(target.port || 5432),
          user: RO_ROLE,
          password: RO_PASSWORD,
          database: target.pathname.slice(1),
        },
      });
      expect(swapped.isError).toBeFalsy();
      expect(JSON.parse(textOf(swapped))).toMatchObject({ host: target.hostname });

      // The read-only role can read...
      const rows = JSON.parse(textOf(await client.callTool({ name: 'query', arguments: { sql: `SELECT count(*)::int AS n FROM ${TABLE}` } })));
      expect(rows.rows[0].n).toBe(3);

      const failed = await client.callTool({
        name: 'connect_db',
        arguments: { host: target.hostname, port: Number(target.port || 5432), user: 'nobody', password: 'wrong', database: 'nope' },
      });
      expect(failed.isError).toBe(true);
      expect(JSON.parse(textOf(failed)).code).toBe('28P01');

      const still = JSON.parse(textOf(await client.callTool({ name: 'query', arguments: { sql: 'SELECT 1 AS ok' } })));
      expect(still.rows[0].ok).toBe(1);
    } finally {
      await close();
    }
  });

  it('describe_table finds the primary key as a SELECT-only role (information_schema hides constraints from it)', async () => {
    // information_schema.table_constraints / key_column_usage only list
    // constraints on tables the role has some NON-SELECT privilege on, so a
    // least-privilege role - the recommended setup - would see every column
    // as is_primary_key:false. Primary keys must come from pg_catalog.
    const { client, close } = await openServer({}, urlAs(RO_ROLE, RO_PASSWORD));
    try {
      const result = await client.callTool({
        name: 'describe_table',
        arguments: { table: TABLE },
      });
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(textOf(result));
      const byName = Object.fromEntries(
        payload.columns.map((c: { column: string; is_primary_key: boolean }) => [c.column, c.is_primary_key])
      );
      expect(byName).toEqual({ id: true, name: false });
    } finally {
      await close();
    }
  });

  it('describe_table reports only key columns as PK, not an index INCLUDE column (review #8)', async () => {
    const INCL = 'mcp_v2_include_pk_test';
    await admin.query(`DROP TABLE IF EXISTS ${INCL}`);
    // pg_index.indkey lists the INCLUDE column too; only conkey is the real PK.
    await admin.query(`CREATE TABLE ${INCL} (id int, payload text, PRIMARY KEY (id) INCLUDE (payload))`);
    await admin.query(`GRANT SELECT ON ${INCL} TO ${RO_ROLE}`);
    const { client, close } = await openServer({}, urlAs(RO_ROLE, RO_PASSWORD));
    try {
      const payload = JSON.parse(
        textOf(await client.callTool({ name: 'describe_table', arguments: { table: INCL } }))
      );
      const byName = Object.fromEntries(
        payload.columns.map((c: { column: string; is_primary_key: boolean }) => [c.column, c.is_primary_key])
      );
      expect(byName).toEqual({ id: true, payload: false });
    } finally {
      await close();
      await admin.query(`DROP TABLE IF EXISTS ${INCL}`);
    }
  });
});
