#!/usr/bin/env node
/**
 * mcp-postgres-server - MCP server for PostgreSQL, read-only by default.
 * Sections: config / connection / database / tools / main.
 * Read-only is engine-enforced (BEGIN READ ONLY); the only real boundary is the connecting role.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import pg from 'pg';
import { parse as parseConnectionString, toClientConfig } from 'pg-connection-string';
import { z } from 'zod';
import net from 'node:net';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { classifyError, ConnectionError, type DatabaseError } from './errors.js';

export { classifyError, ConnectionError };
export type { DatabaseError } from './errors.js';

const VERSION: string = createRequire(import.meta.url)('../package.json').version;

const DEFAULT_PORT = 5432;
const DEFAULT_SSH_PORT = 22;
const DEFAULT_SCHEMA = 'public';

// --- config - all environment handling ---

// PG_SSH_*; consumed only by the optional ssh-connector.
export interface SshConfig {
  host: string;
  port: number;
  user?: string;
  privateKeyPath?: string;
  passphrase?: string;
  agent?: string;
  password?: string;
  fingerprint?: string;
  keepaliveIntervalMs: number;
}

export interface ServerConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: boolean | { rejectUnauthorized?: boolean; ca?: string; checkServerIdentity?: (...args: unknown[]) => Error | undefined };
  readOnly: boolean;
  maxResultBytes: number;
  statementTimeoutMs: number;
  connectTimeoutMs: number;
  allowRuntimeConnect: boolean;
  // Present only when PG_SSH_HOST is set; selects the optional ssh-connector. undefined = direct.
  ssh?: SshConfig;
}

function nonEmpty(raw: string | undefined): string | undefined {
  return raw !== undefined && raw !== '' ? raw : undefined;
}

function positiveIntOr(raw: string | undefined, fallback: number): number {
  const n = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isValidPort(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

// Uniform message for a bad port; isValidPort is the single source for the rule itself.
function portRangeError(subject: string): string {
  return `${subject}: must be a TCP port between 1 and 65535`;
}

// Junk falls back to the default; out of range throws rather than hanging a connect.
function parsePort(raw: string | undefined): number | undefined {
  const value = nonEmpty(raw);
  if (value === undefined) return undefined;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return DEFAULT_PORT;
  if (!isValidPort(n)) {
    throw new Error(portRangeError(`invalid PG_PORT '${value}'`));
  }
  return n;
}

function parseSshPort(raw: string | undefined): number {
  const value = nonEmpty(raw);
  if (value === undefined) return DEFAULT_SSH_PORT;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return DEFAULT_SSH_PORT;
  if (!isValidPort(n)) {
    throw new Error(portRangeError(`invalid PG_SSH_PORT '${value}'`));
  }
  return n;
}

function parseSshConfig(env: Record<string, string | undefined>): SshConfig | undefined {
  const host = nonEmpty(env.PG_SSH_HOST);
  if (host === undefined) return undefined;
  return {
    host,
    port: parseSshPort(env.PG_SSH_PORT),
    user: nonEmpty(env.PG_SSH_USER),
    privateKeyPath: nonEmpty(env.PG_SSH_PRIVATE_KEY),
    passphrase: nonEmpty(env.PG_SSH_PASSPHRASE),
    agent: nonEmpty(env.PG_SSH_AGENT),
    password: nonEmpty(env.PG_SSH_PASSWORD),
    fingerprint: nonEmpty(env.PG_SSH_FINGERPRINT),
    keepaliveIntervalMs: positiveIntOr(env.PG_SSH_KEEPALIVE_INTERVAL, 15000),
  };
}

// pg lets these URL params override our `ssl` option (`?sslmode=verify-full&ssl=0` connects
// plaintext), so we strip them. URL cert paths unsupported; use PG_SSL_CA.
const SSL_URL_PARAMS = new Set(['ssl', 'sslmode', 'sslnegotiation', 'sslcert', 'sslkey', 'sslrootcert']);

function splitConnectionUrl(connectionString: string): { base: string; params: URLSearchParams } {
  const q = connectionString.indexOf('?');
  return q === -1
    ? { base: connectionString, params: new URLSearchParams() }
    : { base: connectionString.slice(0, q), params: new URLSearchParams(connectionString.slice(q + 1)) };
}

function ciGet(params: URLSearchParams, name: string): string | undefined {
  for (const [key, value] of params) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

// Matched by DECODED name, so a percent-encoded `%73sl=0` is caught too.
function stripSslParams(connectionString: string): string {
  const { base, params } = splitConnectionUrl(connectionString);
  for (const key of [...params.keys()]) {
    if (SSL_URL_PARAMS.has(key.toLowerCase())) params.delete(key);
  }
  const rest = params.toString();
  return rest ? `${base}?${rest}` : base;
}

const KNOWN_SSLMODES = new Set(['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']);

// ssl options for a sslmode via pg-connection-string (useLibpqCompat), so libpq semantics aren't
// hand-rolled. A CA alone implies verify-full; unknown modes fail loudly.
function sslForMode(sslMode: string | undefined, caPath: string | undefined): ServerConfig['ssl'] {
  if (sslMode === undefined && caPath === undefined) return undefined;
  const requested = sslMode ?? 'verify-full';
  if (!KNOWN_SSLMODES.has(requested)) {
    throw new Error(`unrecognized sslmode '${requested}': use ${[...KNOWN_SSLMODES].join(' | ')}`);
  }
  // pg-connection-string has no 'allow' case (libpq prefers non-SSL, impossible in node); alias to prefer.
  const mode = requested === 'allow' ? 'prefer' : requested;
  const params = new URLSearchParams({ sslmode: mode });
  if (caPath !== undefined) params.set('sslrootcert', caPath);
  const ssl = parseConnectionString(`postgres://h/d?${params.toString()}`, { useLibpqCompat: true }).ssl as ServerConfig['ssl'];
  // Verifying modes: pin rejectUnauthorized so an inherited NODE_TLS_REJECT_UNAUTHORIZED=0 can't
  // disable verification. require/prefer keep their deliberate false.
  if (typeof ssl === 'object' && ssl !== null && ssl.rejectUnauthorized === undefined && (mode === 'verify-ca' || mode === 'verify-full')) {
    ssl.rejectUnauthorized = true;
  }
  return ssl;
}

export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const connectionString = nonEmpty(env.DATABASE_URL);

  // TLS precedence (case-insensitive): URL sslmode, then URL ssl=true|false, then PG_SSLMODE.
  let sslMode: string | undefined;
  if (connectionString !== undefined) {
    const params = splitConnectionUrl(connectionString).params;
    sslMode = ciGet(params, 'sslmode')?.toLowerCase();
    if (sslMode === undefined) {
      // ssl=true means verify (native pg default), NOT the no-verify `require`.
      const flag = ciGet(params, 'ssl')?.toLowerCase();
      if (flag === 'true' || flag === '1') sslMode = 'verify-full';
      else if (flag === 'false' || flag === '0') sslMode = 'disable';
    }
  }
  if (sslMode === undefined) sslMode = nonEmpty(env.PG_SSLMODE)?.toLowerCase();
  const caPath = nonEmpty(env.PG_SSL_CA);
  const ssl = sslForMode(sslMode, caPath);

  return {
    connectionString: connectionString !== undefined ? stripSslParams(connectionString) : undefined,
    host: env.PG_HOST,
    port: parsePort(env.PG_PORT),
    user: env.PG_USER,
    password: env.PG_PASSWORD,
    database: env.PG_DATABASE,
    ssl,
    readOnly: env.PG_ALLOW_WRITE !== 'true',
    maxResultBytes: positiveIntOr(env.PG_MAX_RESULT_BYTES, 32768),
    statementTimeoutMs: positiveIntOr(env.PG_STATEMENT_TIMEOUT, 30000),
    connectTimeoutMs: positiveIntOr(env.PG_CONNECT_TIMEOUT, 10000),
    allowRuntimeConnect: env.PG_ENABLE_RUNTIME_CONNECT === 'true',
    ssh: parseSshConfig(env),
  };
}

// --- connection - client construction (injectable for tests) ---

// query_timeout is the client-side deadline outliving the server timeout on a stalled socket; it must
// exceed statement_timeout. pipeline sends query and ROLLBACK in one round-trip (pg 8.23+).
export function baseClientOptions(cfg: ServerConfig) {
  return {
    connectionTimeoutMillis: cfg.connectTimeoutMs,
    query_timeout: cfg.statementTimeoutMs + cfg.connectTimeoutMs,
    pipeline: true,
    ...(cfg.ssl !== undefined ? { ssl: cfg.ssl } : {}),
  };
}

// pg-connection-string keeps the brackets on an IPv6 literal (`[::1]`), which getaddrinfo can't
// resolve; strip them. Non-IPv6 hosts pass through.
function normalizeHost(host: string | undefined): string | undefined {
  if (host === undefined) return host;
  const m = /^\[(.+)\]$/.exec(host);
  return m !== null && net.isIP(m[1]) !== 0 ? m[1] : host;
}

// The COMPLETE pg client options, for both connectors. A tunneling connector reuses this and
// overrides only the endpoint (host/port) and TLS servername.
export function resolveClientOptions(cfg: ServerConfig): pg.ClientConfig {
  const parsed: pg.ClientConfig = cfg.connectionString !== undefined
    ? toClientConfig(parseConnectionString(cfg.connectionString))
    : { host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database };
  const options: pg.ClientConfig = { ...parsed, ...baseClientOptions(cfg) };
  options.host = normalizeHost(options.host ?? undefined);
  // Validate before connect (a URL `?port=` lands here too), else pg wraps an out-of-range value
  // and ERR_SOCKET_BAD_PORT crashes the process.
  if (options.port !== undefined && !isValidPort(options.port)) {
    throw new Error(portRangeError(`invalid port ${options.port}`));
  }
  return options;
}

export function defaultClientFactory(cfg: ServerConfig): pg.Client {
  return new pg.Client(resolveClientOptions(cfg));
}

// A live, connected pg client plus any resources behind it (e.g. an SSH tunnel); close() releases all, idempotently.
export interface Connection {
  client: pg.Client;
  close(): Promise<void>;
  // Transport-agnostic diagnosis of a failure just seen on `client` (e.g. a dropped SSH tunnel),
  // else undefined. The data layer runs it through the shared mapper, unaware of the transport.
  diagnose?(): ConnectionError | undefined;
}

// Opens a live Connection (client already connected); on failure it rejects having released what it
// opened. Injected so transports (SSH, pooling) and tests vary without the data/tool layers knowing.
export interface Connector {
  connect(cfg: ServerConfig): Promise<Connection>;
}

// A plain pg client; on connect failure it ends the half-open socket so the original error survives.
export const defaultConnector: Connector = {
  async connect(cfg) {
    const client = defaultClientFactory(cfg);
    try {
      await client.connect();
    } catch (err) {
      await client.end().catch(() => undefined);
      throw err;
    }
    return { client, close: () => client.end().catch(() => undefined) };
  },
};

// EXTENDED protocol, so the engine rejects multi-command strings (queryMode lags in @types/pg, hence the cast).
function extendedQuery(text: string, values: unknown[]): pg.QueryConfig {
  return { text, values, queryMode: 'extended' } as pg.QueryConfig & { queryMode: string };
}

// --- database - typed, application-owned data access (hides pg.Client) ---

export interface QueryData {
  rows: unknown[];
  rowCount: number;
  returnedRows: number;
  truncated: boolean;
  hint?: string;
}
export interface ExecData {
  rowCount: number | null;
  command: string;
}
export interface ColumnInfo {
  column: string;
  type: string;
  nullable: boolean;
  default: string | null;
  is_primary_key: boolean;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: DatabaseError };

// Typed data access that owns the pg client (never leaks it), so tool handlers depend on this, not pg.
export interface Database {
  query(sql: string, params?: unknown[]): Promise<Result<QueryData>>;
  execute(sql: string, params?: unknown[]): Promise<Result<ExecData>>;
  listSchemas(): Promise<Result<{ schemas: string[] }>>;
  listTables(schema: string): Promise<Result<{ tables: string[] }>>;
  describeTable(schema: string, table: string): Promise<Result<{ columns: ColumnInfo[] }>>;
  retarget(target: { host: string; port?: number; user: string; password: string; database: string }): Promise<Result<{ host: string; database: string }>>;
  close(): Promise<void>;
}

// Keep whole rows whose compact-JSON size fits maxBytes, so the payload is bounded by size, not a row
// count. Strict: if not even the first row fits, none are returned (the caller reports that).
export function capBySize<T>(rows: T[], maxBytes: number): { rows: T[]; truncated: boolean } {
  const kept: T[] = [];
  let bytes = 2; // enclosing []
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1; // + separator
    if (bytes + size > maxBytes) break;
    kept.push(row);
    bytes += size;
  }
  return { rows: kept, truncated: kept.length < rows.length };
}


// Owns one lazily-connected pg client; reconnects after errors and re-applies session settings.
export function createDatabase(
  config: ServerConfig,
  connector: Connector = defaultConnector
): Database {
  let activeConfig: ServerConfig = { ...config };
  let connection: Connection | null = null;
  // Teardowns started off the op queue (the client 'error' handler) accumulate here so close() can
  // await them, and cleanup failures are logged in one place, never thrown.
  let pendingCleanup: Promise<void> = Promise.resolve();

  // Release a connection once; a cleanup failure is logged, never thrown, so it can't mask an original error.
  function teardown(conn: Connection): Promise<void> {
    const done = Promise.resolve()
      .then(() => conn.close())
      .catch((err: unknown) => {
        console.error(`[postgres-server] connection cleanup failed: ${classifyError(err).message}`);
      });
    pendingCleanup = pendingCleanup.then(() => done);
    return done;
  }

  // One queue: ops run one at a time, so parallel calls cannot double-connect or tangle BEGIN/ROLLBACK.
  let chain: Promise<unknown> = Promise.resolve();
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  async function applySessionSettings(c: pg.Client): Promise<void> {
    // Bound-value set_config (no interpolation). Both are best-effort under a transaction pooler -
    // the client-side query_timeout is the real backstop.
    const timeoutMs = String(Math.max(0, Math.floor(activeConfig.statementTimeoutMs)));
    await c.query('SELECT set_config($1, $3, false), set_config($2, $3, false)', [
      'statement_timeout',
      'idle_in_transaction_session_timeout',
      timeoutMs,
    ]);
    if (activeConfig.readOnly) {
      try {
        const check = await c.query("SELECT current_setting('is_superuser') AS is_superuser");
        if (check.rows[0]?.is_superuser === 'on') {
          console.error(
            '[postgres-server] warning: connected as a superuser. Read-only is enforced by the engine (BEGIN READ ONLY); the only real boundary is a least-privilege role - see SECURITY.md.'
          );
        }
      } catch {
        // advisory only - never fail the connection over it
      }
    }
  }

  async function getClient(): Promise<pg.Client> {
    if (connection !== null) return connection.client;
    if (
      activeConfig.connectionString === undefined &&
      activeConfig.host === undefined &&
      activeConfig.user === undefined &&
      activeConfig.database === undefined
    ) {
      throw new Error(
        'no database configured: set DATABASE_URL or PG_HOST/PG_USER/PG_PASSWORD/PG_DATABASE (or set PG_ENABLE_RUNTIME_CONNECT=true and use connect_db)'
      );
    }
    const conn = await connector.connect(activeConfig);
    // An unhandled 'error' event would crash the process; on a dropped socket route the teardown
    // through the shared lifecycle so the next call reconnects cleanly.
    conn.client.on('error', (err: Error) => {
      console.error(`[postgres-server] connection error: ${err.message}`);
      if (connection === conn) {
        connection = null;
        void teardown(conn);
      }
    });
    try {
      await applySessionSettings(conn.client);
    } catch (err) {
      // A tunnel drop during setup has a transport diagnosis; surface it, else the original error.
      const transport = conn.diagnose?.();
      await teardown(conn); // never throws, so the original setup error is preserved
      throw transport ?? err;
    }
    connection = conn;
    return conn.client;
  }

  // Left inside a transaction (open or aborted), from pg's local ReadyForQuery status (no round-trip).
  function leftInTransaction(c: pg.Client): boolean {
    const status = (c as unknown as { getTransactionStatus(): string | null }).getTransactionStatus();
    return status === 'T' || status === 'E';
  }

  // Run body serialized; pg errors become a typed failure. A call left in a transaction (a bare BEGIN) is discarded.
  async function run<T>(body: (c: pg.Client) => Promise<T>): Promise<Result<T>> {
    return serialized(async () => {
      let c: pg.Client;
      try {
        c = await getClient();
      } catch (err) {
        return { ok: false, error: classifyError(err) };
      }
      // getClient guarantees a live connection; prefer its transport diagnosis over pg's message.
      const conn = connection as Connection;
      const result: Result<T> = await body(c).then(
        (data) => ({ ok: true, data }),
        (err) => ({ ok: false, error: classifyError(conn.diagnose?.() ?? err) })
      );
      if (connection !== null && connection.client === c && leftInTransaction(c)) {
        await discardConnection();
        // Transactions can't span tool calls, so report that instead of a misleading success; keep a real SQL error.
        if (result.ok) {
          return {
            ok: false,
            error: { message: 'transaction control is not supported: transactions cannot span tool calls; do not use BEGIN/COMMIT/SAVEPOINT' },
          };
        }
      }
      return result;
    });
  }

  const guardFailure = (reason: string): Result<never> => ({ ok: false, error: { message: reason } });

  async function discardConnection(): Promise<void> {
    const conn = connection;
    connection = null;
    if (conn !== null) await teardown(conn);
  }

  // A read in a rolled-back READ ONLY transaction: the engine refuses any write, even one hidden in
  // a function/view/rule. BEGIN is awaited, then query and ROLLBACK pipeline into one round-trip.
  async function readInTransaction(c: pg.Client, sql: string, params: unknown[]): Promise<pg.QueryResult> {
    await c.query('BEGIN READ ONLY');
    const [query, rollback] = await Promise.allSettled([
      c.query(extendedQuery(sql, params)),
      c.query('ROLLBACK'),
    ]);
    if (rollback.status === 'rejected') {
      // Rollback failed -> session state unknown: drop the connection, report the failure.
      await discardConnection();
      throw query.status === 'rejected' ? query.reason : rollback.reason;
    }
    if (query.status === 'rejected') throw query.reason;
    return query.value;
  }

  function queryData(result: pg.QueryResult): QueryData {
    const total = result.rowCount ?? result.rows.length;
    const capped = capBySize(result.rows, activeConfig.maxResultBytes);
    const returnedRows = capped.rows.length;
    const budget = activeConfig.maxResultBytes;
    const hint = !capped.truncated
      ? undefined
      : returnedRows === 0
        ? `no row fits the ~${budget}-byte result budget: select fewer or narrower columns (or raise PG_MAX_RESULT_BYTES)`
        : `returned ${returnedRows} of ${total} rows (~${budget}-byte budget): add LIMIT/WHERE or select fewer columns`;
    return {
      rows: capped.rows,
      rowCount: total,
      returnedRows,
      truncated: capped.truncated,
      ...(hint !== undefined ? { hint } : {}),
    };
  }

  return {
    query(sql, params) {
      // Read-only wraps the read so the engine refuses any write; write mode sends it directly.
      return run(async (c) =>
        queryData(
          activeConfig.readOnly
            ? await readInTransaction(c, sql, params ?? [])
            : await c.query(extendedQuery(sql, params ?? []))
        )
      );
    },

    execute(sql, params) {
      // Registered for discoverability, but a write is refused here in read-only mode - the SQL never reaches the DB.
      if (activeConfig.readOnly) {
        return Promise.resolve(guardFailure('the server is read-only; set PG_ALLOW_WRITE=true to enable writes'));
      }
      return run(async (c) => {
        const result = await c.query(extendedQuery(sql, params ?? []));
        return { rowCount: result.rowCount, command: result.command };
      });
    },

    listSchemas() {
      return run(async (c) => {
        const result = await c.query<{ schema_name: string }>(
          'SELECT schema_name FROM information_schema.schemata ORDER BY schema_name'
        );
        return { schemas: result.rows.map((r) => r.schema_name) };
      });
    },

    listTables(schema) {
      return run(async (c) => {
        const result = await c.query<{ table_name: string }>(
          'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name',
          [schema]
        );
        return { tables: result.rows.map((r) => r.table_name) };
      });
    },

    describeTable(schema, table) {
      return run(async (c) => {
        const result = await c.query<{
          column_name: string;
          data_type: string;
          is_nullable: string;
          column_default: string | null;
          is_primary_key: boolean;
        }>(
          // PK from pg_constraint.conkey (information_schema hides it from SELECT-only roles; indkey includes INCLUDE cols).
          `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
                  COALESCE(pk.is_pk, false) AS is_primary_key
           FROM information_schema.columns c
           LEFT JOIN (
             SELECT a.attname AS column_name, true AS is_pk
             FROM pg_catalog.pg_constraint con
             JOIN pg_catalog.pg_class t ON t.oid = con.conrelid
             JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
             JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
             WHERE con.contype = 'p' AND n.nspname = $1 AND t.relname = $2
           ) pk ON c.column_name = pk.column_name
           WHERE c.table_schema = $1 AND c.table_name = $2
           ORDER BY c.ordinal_position`,
          [schema, table]
        );
        return {
          columns: result.rows.map((r) => ({
            column: r.column_name,
            type: r.data_type,
            nullable: r.is_nullable === 'YES',
            default: r.column_default,
            is_primary_key: r.is_primary_key === true,
          })),
        };
      });
    },

    retarget(target) {
      if (target.port !== undefined && !isValidPort(target.port)) {
        return Promise.resolve(guardFailure(portRangeError(`invalid port ${target.port}`)));
      }
      return serialized(async () => {
        const previousConfig = activeConfig;
        // discardConnection clears the ref before closing, so the old connection's error handler
        // (which checks `connection === conn`) can never null the new one.
        await discardConnection();
        activeConfig = { ...activeConfig, connectionString: undefined, host: target.host, port: target.port ?? DEFAULT_PORT, user: target.user, password: target.password, database: target.database };
        try {
          await getClient();
          return { ok: true, data: { host: target.host, database: target.database } };
        } catch (err) {
          activeConfig = previousConfig; // roll back so later calls retry the old target
          connection = null;
          return { ok: false, error: classifyError(err) };
        }
      });
    },

    close() {
      // Idempotent: close the connection, then await any out-of-band teardown, so nothing exits mid-close.
      return serialized(async () => {
        await discardConnection();
        await pendingCleanup;
      });
    },
  };
}

// --- tools - the MCP tool surface (thin: validate input, map Result to MCP) ---

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

// Compact JSON (no pretty-printing - tokens matter).
function textResult(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

// An isError result (not a thrown protocol error) so the model can read it and self-correct.
function errorResult(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true };
}

const paramsShape = z
  .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .optional()
  .describe('Positional parameter values bound to $1, $2, ... placeholders.');

function reply<T>(result: Result<T>): ToolResult {
  return result.ok ? textResult(result.data) : errorResult(result.error);
}

// execute is always registered (refuses in read-only mode); connect_db is gated - an unregistered tool can't be called.
function registerTools(server: McpServer, db: Database, config: ServerConfig): void {
  const capHint = `Prefer $1, $2 placeholders with the params array over interpolating values. Results are capped at ~${config.maxResultBytes} bytes; truncated:true means rows were dropped - add LIMIT/WHERE or select fewer columns.`;
  server.registerTool(
    'query',
    {
      // Mode-aware: engine-enforced read-only, or (with PG_ALLOW_WRITE=true) sent directly and able to write.
      title: config.readOnly ? 'Run read-only SQL' : 'Run SQL',
      description: config.readOnly
        ? 'Run one read-only SQL statement against the connected PostgreSQL database and get rows back as JSON. ' +
          'Send exactly one statement per call (SELECT, WITH, EXPLAIN, or SHOW). It runs inside an engine-enforced read-only transaction, so any write is refused by the database. ' +
          'Use this tool for all data reading, aggregation, and query planning. ' +
          capHint
        : 'Run one SQL statement against the connected PostgreSQL database and get rows back as JSON. ' +
          'Because the server was started with PG_ALLOW_WRITE=true, the statement is sent directly and can modify data - use the execute tool for writes and this for reads. Send exactly one statement per call. ' +
          capHint,
      inputSchema: {
        sql: z.string().describe('One SQL statement. Use $1, $2, ... for parameters.'),
        params: paramsShape,
      },
      annotations: { readOnlyHint: config.readOnly, openWorldHint: false },
    },
    async ({ sql, params }) => reply(await db.query(sql, params))
  );

  server.registerTool(
    'execute',
    {
      title: 'Run a write statement',
      description: config.readOnly
        ? 'Run a data-modifying SQL statement (INSERT/UPDATE/DELETE or DDL). Currently DISABLED: the server is read-only, so this returns an error and changes nothing. To enable writes, the operator must start the server with PG_ALLOW_WRITE=true.'
        : 'Run one data-modifying SQL statement - INSERT, UPDATE, DELETE, or DDL like CREATE/ALTER - and get the affected row count back. ' +
          'Use the query tool for anything that reads. Send exactly one complete statement per call; do not use explicit transaction or session control (BEGIN, COMMIT, SET, ...). ' +
          'Prefer $1, $2 placeholders with the params array. This tool exists because the server was started with PG_ALLOW_WRITE=true.',
      inputSchema: {
        sql: z
          .string()
          .describe('One INSERT / UPDATE / DELETE / DDL statement. Use $1, $2, ... for parameters.'),
        params: paramsShape,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ sql, params }) => reply(await db.execute(sql, params))
  );

  server.registerTool(
    'list_schemas',
    {
      title: 'List schemas',
      description:
        'List every schema in the connected database. Start here when exploring an unfamiliar database, then call list_tables for the schema you care about.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => reply(await db.listSchemas())
  );

  server.registerTool(
    'list_tables',
    {
      title: 'List tables',
      description:
        "List all tables in a schema (default: 'public'). Use this before querying tables you have not seen yet, then call describe_table for column details.",
      inputSchema: {
        schema: z.string().optional().describe("Schema name (default: 'public')"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ schema }) => reply(await db.listTables(schema ?? DEFAULT_SCHEMA))
  );

  server.registerTool(
    'describe_table',
    {
      title: 'Describe a table',
      description:
        'Show the structure of one table: column names, data types, nullability, defaults, and primary-key membership. Call this before writing non-trivial queries against a table.',
      inputSchema: {
        table: z.string().describe('Table name'),
        schema: z.string().optional().describe("Schema name (default: 'public')"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ table, schema }) => reply(await db.describeTable(schema ?? DEFAULT_SCHEMA, table))
  );

  if (config.allowRuntimeConnect) {
    server.registerTool(
      'connect_db',
      {
        title: 'Connect to a different database',
        description:
          'Switch the server to a different PostgreSQL database at runtime, replacing the current connection. ' +
          'Only use this when the user explicitly asks to connect elsewhere or the configured connection fails - normal operation uses the connection from the environment. ' +
          'Read-only mode and the statement timeout are re-applied to the new connection.',
        inputSchema: {
          host: z.string().describe('Database host'),
          port: z.number().optional().describe('Database port (default: 5432)'),
          user: z.string().describe('Database user'),
          password: z.string().describe('Database password'),
          database: z.string().describe('Database name'),
        },
        annotations: { readOnlyHint: false, openWorldHint: true },
      },
      async ({ host, port, user, password, database }) => {
        const result = await db.retarget({ host, port, user, password, database });
        return result.ok
          ? textResult({ message: 'Successfully connected to PostgreSQL database', ...result.data })
          : errorResult(result.error);
      }
    );
  }
}

// MCP server over one database, plus an awaitable close() for both (server.close alone doesn't await the db).
export function createApp(
  config: ServerConfig,
  connector: Connector = defaultConnector
): { server: McpServer; close: () => Promise<void> } {
  const server = new McpServer({ name: 'postgres-server', version: VERSION });
  const db = createDatabase(config, connector);
  registerTools(server, db, config);
  // Also close the db if the transport closes on its own (SDK leaves onclose unset).
  server.server.onclose = () => void db.close();
  return {
    server,
    close: async () => {
      try {
        await server.close();
      } finally {
        await db.close(); // idempotent; runs even if server.close threw
      }
    },
  };
}

export function createServer(
  config: ServerConfig,
  connector: Connector = defaultConnector
): McpServer {
  return createApp(config, connector).server;
}

// --- main - stdio transport; only runs when executed directly, never on import ---

// The slice of `process` main() touches - injected so the entry point runs under test.
export interface ProcessLike {
  env: Record<string, string | undefined>;
  on(event: 'SIGINT' | 'SIGTERM', handler: () => void): unknown;
  stdin: { on(event: 'close', handler: () => void): unknown };
  exit(code: number): void;
}

export async function main(proc: ProcessLike, transport: Transport): Promise<void> {
  const cfg = loadConfig(proc.env);
  // Load the optional SSH connector (and ssh2) only when configured; a direct connection uses the default.
  const connector = cfg.ssh ? (await import('./ssh-connector.js')).createSshConnector(cfg.ssh) : defaultConnector;
  const app = createApp(cfg, connector);

  const shutdown = (): void => {
    app
      .close()
      .catch(() => undefined)
      .finally(() => proc.exit(0));
  };
  proc.on('SIGINT', shutdown);
  proc.on('SIGTERM', shutdown);
  proc.stdin.on('close', shutdown);

  await app.server.connect(transport);
  // stdout is the protocol channel - all logging goes to stderr.
  console.error(
    `[postgres-server] v${VERSION} running on stdio in ${
      cfg.readOnly ? 'read-only mode (set PG_ALLOW_WRITE=true to enable writes)' : 'READ-WRITE mode'
    }${cfg.allowRuntimeConnect ? '; runtime connect_db enabled' : ''}`
  );
}

// True when `entry` (process.argv[1]) is this module - directly or through an npm bin symlink.
export function isEntryPoint(entry: string | undefined, moduleUrl: string): boolean {
  if (!entry) return false;
  if (moduleUrl === pathToFileURL(entry).href) return true;
  try {
    return moduleUrl === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

export const stdioTransport = (): Transport => new StdioServerTransport();

// Run main() only when this file is the executed entry point - never on import.
export function bootstrap(
  entry: string | undefined,
  moduleUrl: string,
  proc: ProcessLike,
  makeTransport: () => Transport
): void {
  if (!isEntryPoint(entry, moduleUrl)) return;
  main(proc, makeTransport()).catch((err) => {
    console.error('[postgres-server] fatal:', err);
    proc.exit(1);
  });
}

bootstrap(process.argv[1], import.meta.url, process, stdioTransport);
