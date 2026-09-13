# MCP PostgreSQL Server

A Model Context Protocol (MCP) server for PostgreSQL: **read-only by default**,
for local, Docker, RDS, Neon, and Supabase databases.

The server is a small, auditable codebase ([`src/index.ts`](src/index.ts), the shared
[`src/errors.ts`](src/errors.ts), and the optional [`src/ssh-connector.ts`](src/ssh-connector.ts))
with four runtime dependencies: the MCP SDK, `pg`, `pg-connection-string`, and
`zod` (plus `ssh2`, an optional dependency used only for SSH tunneling).
Read-only is enforced by PostgreSQL itself.

Requires Node.js 20 or newer.

## Installation

### Manual Installation

```bash
npm install mcp-postgres-server
```

Or run directly with:

```bash
npx mcp-postgres-server
```

## Configuration

The preferred way to configure the server is a single `DATABASE_URL`:

```json
{
  "mcpServers": {
    "postgres": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-postgres-server"],
      "env": {
        "DATABASE_URL": "postgres://user:password@localhost:5432/mydb",
        "PG_ALLOW_WRITE": "false"
      }
    }
  }
}
```

With `PG_ALLOW_WRITE` set to `"false"` the server has **read-only access** to the
database. This is the default; set it to `"true"` only if the model must write.

Alternatively, set the individual `PG_*` variables; they are used when
`DATABASE_URL` is not set:

```json
{
  "mcpServers": {
    "postgres": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-postgres-server"],
      "env": {
        "PG_HOST": "your_host",
        "PG_PORT": "5432",
        "PG_USER": "your_user",
        "PG_PASSWORD": "your_password",
        "PG_DATABASE": "your_database",
        "PG_ALLOW_WRITE": "false"
      }
    }
  }
}
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | - | Full connection string (preferred). Supports `?sslmode=` in the URL. |
| `PG_HOST` | - | Database host (fallback when `DATABASE_URL` is not set) |
| `PG_PORT` | `5432` | Database port |
| `PG_USER` | - | Database user |
| `PG_PASSWORD` | - | Database password |
| `PG_DATABASE` | - | Database name |
| `PG_ALLOW_WRITE` | `false` | When `true`, `execute` performs writes and reads are sent directly. Off (default) is read-only: `execute` refuses writes and each read runs in a `READ ONLY` transaction |
| `PG_SSLMODE` | - | `disable` \| `allow` \| `prefer` \| `require` \| `verify-ca` \| `verify-full`. `require`/`allow`/`prefer` encrypt without verifying the certificate; `verify-ca`/`verify-full` verify (supply a CA via `PG_SSL_CA`). Unrecognized values fail at startup. **Limitation:** unlike libpq, `allow`/`prefer` do not fall back to plaintext (node-postgres has no opportunistic SSL), so a server without TLS needs `disable`. |
| `PG_SSL_CA` | - | Path to a CA certificate file. Setting it by itself implies `verify-full` |
| `PG_ENABLE_RUNTIME_CONNECT` | `false` | Register the `connect_db` tool (runtime credential switching) |
| `PG_MAX_RESULT_BYTES` | `32768` | Byte budget for a `query` result sent to the model. Whole rows are kept while they fit; over the budget `returnedRows < rowCount` and `truncated: true` (if not even the first row fits, `returnedRows` is 0 with a hint). ~32 KiB ≈ 8k tokens; lower it for strict clients, raise it if your client allows more. |
| `PG_STATEMENT_TIMEOUT` | `30000` | Statement timeout in milliseconds, applied to every session |
| `PG_CONNECT_TIMEOUT` | `10000` | Timeout in milliseconds for a single connect attempt (raise it for slow links or SSH tunnels) |
| `PG_SSH_HOST` | - | SSH bastion host. **Setting it enables tunneling**: the server reaches the database only through an SSH tunnel to this host (see below). Optional feature; needs the `ssh2` optional dependency. |
| `PG_SSH_PORT` | `22` | SSH bastion port |
| `PG_SSH_USER` | - | SSH username |
| `PG_SSH_PRIVATE_KEY` | - | Path to a private key file. If unset, auth falls back like `ssh`: a running agent (`SSH_AUTH_SOCK`), then a default key (`~/.ssh/id_ed25519`, `id_rsa`, `id_ecdsa`) |
| `PG_SSH_PASSPHRASE` | - | Passphrase for the private key, if encrypted |
| `PG_SSH_AGENT` | - | `true` to use the ambient agent (`SSH_AUTH_SOCK`), or an explicit socket path / Windows named pipe (`\\.\pipe\openssh-ssh-agent`) |
| `PG_SSH_PASSWORD` | - | SSH login password. Opt-in; a key or agent takes precedence. Prefer keys - a bastion often disables password auth. |
| `PG_SSH_FINGERPRINT` | - | Pinned host-key fingerprint (`SHA256:...`). **Host-key verification is mandatory and set only this way**: without it the tunnel refuses to connect (fail-closed). Get it with `ssh-keygen -lF host` (reads your `known_hosts`) or `ssh-keyscan host \| ssh-keygen -lf -` (see the trust note below) |
| `PG_SSH_KEEPALIVE_INTERVAL` | `15000` | SSH keepalive interval in ms; the tunnel drops after 3 unanswered keepalives, and the next call reconnects |

### Connecting over an SSH tunnel

Set `PG_SSH_HOST` (plus auth and host-key verification) to reach a database that is only accessible
through a bastion. The connection string / `PG_*` fields then describe the database **as seen from the
bastion**:

```json
{
  "mcpServers": {
    "postgres": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-postgres-server"],
      "env": {
        "DATABASE_URL": "postgres://mcp_readonly:secret@db.internal:5432/mydb?sslmode=verify-full",
        "PG_SSH_HOST": "bastion.example.com",
        "PG_SSH_USER": "jump",
        "PG_SSH_PRIVATE_KEY": "/home/me/.ssh/id_ed25519",
        "PG_SSH_FINGERPRINT": "SHA256:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

- **SSH changes only the transport.** Read-only enforcement, the result size cap, timeouts, and
  `connect_db` behave exactly as on a direct connection, and no extra SQL is sent per query.
- **Host-key verification is mandatory** via a pinned `PG_SSH_FINGERPRINT` - the tunnel will not
  connect without it, so a man-in-the-middle bastion is refused. Get the fingerprint over a channel
  you trust, most trustworthy first:
  - on the bastion itself, or from its admin: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`
    (no network involved);
  - from your existing `~/.ssh/known_hosts`, if you already reach the host over `ssh`:
    `ssh-keygen -lF bastion.example.com`;
  - fetched from the host: `ssh-keyscan bastion.example.com | ssh-keygen -lf -` (trust this only
    when run from a network position you trust - it accepts whatever the host returns).
- **TLS validates the real database hostname.** With `verify-full`, the certificate is checked against
  the database's own hostname (e.g. `db.internal`), not the loopback the tunnel binds locally, and
  `rejectUnauthorized` is pinned on so an inherited `NODE_TLS_REJECT_UNAUTHORIZED=0` cannot disable it.
- **`ssh2` is an optional dependency**, loaded only when `PG_SSH_HOST` is set, so a direct connection
  never initializes it. npm installs optional dependencies by default; run
  `npm install --omit=optional` to skip it entirely (a direct connection does not need it).

When a tunneled connection fails, the tool result carries a stable `code` (and, where the cause is
determinate, a hint naming the setting to fix), so the failing phase is unambiguous:

| code | meaning | first thing to check |
|------|---------|----------------------|
| `SSH_CONFIG_INVALID` | invalid SSH config, incl. a malformed `PG_SSH_FINGERPRINT` | the `PG_SSH_*` values |
| `SSH_KEY_INVALID` | key unreadable, unparseable, a public key, or encrypted without the right passphrase (an encrypted key with the correct `PG_SSH_PASSPHRASE` works) | `PG_SSH_PRIVATE_KEY`, `PG_SSH_PASSPHRASE` |
| `SSH_CONNECT_FAILED` | the bastion is unreachable, or SSH setup failed for an unclassified reason | `PG_SSH_HOST`, `PG_SSH_PORT`, reachability |
| `SSH_TIMEOUT` | the bastion did not respond in time | network/firewall, `PG_CONNECT_TIMEOUT` |
| `SSH_AUTH_FAILED` | the bastion rejected authentication | `PG_SSH_USER` and the key/agent/password in use |
| `SSH_HOST_KEY_MISMATCH` | host key does not match `PG_SSH_FINGERPRINT` (stale value or MITM) | re-fetch the fingerprint (above) |
| `SSH_FORWARD_FAILED` | tunnel is up, but the bastion could not reach the database | the DB host and port as seen from the bastion |
| `SSH_CONNECTION_LOST` | an established tunnel dropped mid-session | transient; the next call reconnects |

A genuine PostgreSQL error through a healthy tunnel keeps its own code (e.g. `28P01` for wrong
database credentials), not an SSH code.

### Example configurations

**Local Postgres:**

```
DATABASE_URL=postgres://mcp_readonly:secret@localhost:5432/mydb
```

**Postgres in Docker:** if the database runs in a container with a published
port, connect to `localhost:<published-port>` as usual. If the *MCP server
itself* runs inside a container and the database runs on your host machine,
use `host.docker.internal` instead of `localhost`:

```
DATABASE_URL=postgres://mcp_readonly:secret@host.docker.internal:5432/mydb
```

**Amazon RDS:**

```
DATABASE_URL=postgres://mcp_readonly:secret@mydb.xxxxxx.us-east-1.rds.amazonaws.com:5432/mydb?sslmode=require
```

**Neon:**

```
DATABASE_URL=postgres://mcp_readonly:secret@ep-xxx-xxx.us-east-2.aws.neon.tech/mydb?sslmode=require
```

**Supabase:**

```
DATABASE_URL=postgres://postgres.xxxxxxxx:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require
```

## Available Tools

Tool availability depends on configuration:

| Tool | Available |
|------|-----------|
| `query`, `list_schemas`, `list_tables`, `describe_table` | Always |
| `execute` | Always (refuses writes unless `PG_ALLOW_WRITE=true`) |
| `connect_db` | Only when `PG_ENABLE_RUNTIME_CONNECT=true` |

### 1. query

Execute a read-only SQL statement. Accepts `SELECT`, `WITH ... SELECT`,
`EXPLAIN`, and `SHOW`. One statement per call - multi-statement input is rejected
by the extended query protocol. In read-only mode (the default) the statement runs
as `BEGIN READ ONLY`, the query, and `ROLLBACK` - three commands, roughly two
network round trips with pipelining - so the database itself refuses any write.
With `PG_ALLOW_WRITE=true` the statement is sent directly, without that wrapper, so a
write run through `query` would execute - use `execute` for writes.
Supports PostgreSQL-style `$1, $2` prepared-statement parameters; values are bound
by the driver and never spliced into the SQL text.

```javascript
use_mcp_tool({
  server_name: "postgres",
  tool_name: "query",
  arguments: {
    sql: "SELECT * FROM users WHERE id = $1",
    params: [1]
  }
});
```

Returns compact JSON: `{"rows": [...], "rowCount": n, "returnedRows": n, "truncated": false}`.
When the serialized rows exceed `PG_MAX_RESULT_BYTES`, only the rows that fit are returned
(`returnedRows < rowCount`), `truncated` is `true`, and a hint suggests adding `LIMIT`/`WHERE`
or selecting fewer columns.

### 2. list_schemas

List all schemas in the connected database.

```javascript
use_mcp_tool({
  server_name: "postgres",
  tool_name: "list_schemas",
  arguments: {}
});
```

### 3. list_tables

List tables in the connected database. Accepts an optional schema parameter
(defaults to 'public').

```javascript
// List tables in the 'public' schema (default)
use_mcp_tool({
  server_name: "postgres",
  tool_name: "list_tables",
  arguments: {}
});

// List tables in a specific schema
use_mcp_tool({
  server_name: "postgres",
  tool_name: "list_tables",
  arguments: {
    schema: "my_schema"
  }
});
```

### 4. describe_table

Get the structure of a specific table (columns, types, nullability, defaults,
primary keys). Accepts an optional schema parameter (defaults to 'public').

```javascript
use_mcp_tool({
  server_name: "postgres",
  tool_name: "describe_table",
  arguments: {
    table: "users",
    schema: "my_schema"  // optional
  }
});
```

### 5. execute - requires `PG_ALLOW_WRITE=true`

Execute an `INSERT`, `UPDATE`, `DELETE`, or DDL statement. Always registered, but
in read-only mode (the default) it refuses with an error naming `PG_ALLOW_WRITE`
and changes nothing - the statement never reaches the database. With
`PG_ALLOW_WRITE=true` it runs: same `$1, $2` parameter handling as `query`, one
complete statement per call, and the connecting role governs what it may do.
Returns `{"rowCount": n, "command": "INSERT"}`.

```javascript
use_mcp_tool({
  server_name: "postgres",
  tool_name: "execute",
  arguments: {
    sql: "INSERT INTO users (name, email) VALUES ($1, $2)",
    params: ["John Doe", "john@example.com"]
  }
});
```

### 6. connect_db - requires `PG_ENABLE_RUNTIME_CONNECT=true`

Connect to a different PostgreSQL database at runtime using provided
credentials. Not registered by default - prefer configuring credentials
through the environment so they never pass through model-visible arguments.
Session limits (`statement_timeout`, `idle_in_transaction_session_timeout`) are
re-applied after every reconnect; read-only reads enforce read-only in their own
`BEGIN READ ONLY` transaction.

```javascript
use_mcp_tool({
  server_name: "postgres",
  tool_name: "connect_db",
  arguments: {
    host: "localhost",
    port: 5432,
    user: "your_user",
    password: "your_password",
    database: "your_database"
  }
});
```

## Features

* Read-only by default; writes are an explicit opt-in (`PG_ALLOW_WRITE=true`)
* Read-only enforced by the engine (`BEGIN READ ONLY`), never by client-side SQL parsing
* Data access behind a small typed interface; the `pg` driver never leaks past it
* `DATABASE_URL` support with SSL (`sslmode=disable|allow|prefer|require|verify-ca|verify-full`, custom CA)
* Prepared-statement parameters: `$1`-style placeholders, bound by the driver
* Result size cap (byte budget) with an explicit `truncated` flag instead of flooding the model's context
* Session statement timeout plus a client deadline; transaction poolers may not preserve session settings
* Errors returned as readable tool results with SQLSTATE-based hints, so the model can self-correct
* Survives dropped connections - reconnects lazily instead of crashing
* Optional SSH tunneling (`PG_SSH_*`) with mandatory host-key verification, loaded only when configured
* MCP tool annotations (read-only / destructive hints) per spec 2025-11-25
* Multi-schema support for database operations

## Security

Full details, including the threat model and disclosure process, are in
[SECURITY.md](SECURITY.md). The short version:

1. **A least-privilege database role is the real boundary.** The MCP works with
   existing credentials; creating or changing roles is not required. A dedicated
   role is what actually guarantees writes are impossible.
   On PostgreSQL 14+, the following is a starting point:

   ```sql
   CREATE ROLE mcp_readonly LOGIN PASSWORD 'change-me';
   GRANT CONNECT ON DATABASE your_database TO mcp_readonly;
   GRANT pg_read_all_data TO mcp_readonly;                          -- adds read privileges
   ALTER ROLE mcp_readonly SET default_transaction_read_only = on;  -- read-only by default
   ```

   (On PostgreSQL 13 or older, grant `SELECT` explicitly instead of
   `pg_read_all_data` - see [SECURITY.md](SECURITY.md).) The server warns on
   stderr if you connect as a superuser. Read grants do not revoke existing
   privileges, and defaults remain mutable; available functions, ownership and
   inherited privileges also matter.

2. **The engine enforces read-only.** There is no client-side SQL parsing. In
   read-only mode every read runs in a rolled-back `BEGIN READ ONLY` transaction,
   so PostgreSQL itself - which alone knows what a function, view, or rule does -
   refuses any write with SQLSTATE 25006 and reverts any session change the
   statement made. The extended protocol rejects multi-command strings.

**Honest framing:** the read-only transaction is defense-in-depth on top of the
role, not a replacement for it. Read-only mode stops a confused or prompt-injected
model from *writing* to your database; it does not stop prompt injection carried in
the row data a query returns. Don't point this server at production - use a replica,
a snapshot, or a tightly scoped role. See [SECURITY.md](SECURITY.md).

## Error Handling

SQL and connection failures are returned as tool results (`isError: true`)
with a message, the SQLSTATE code, and a hint. PostgreSQL's own server hint is
used when present; otherwise these fallbacks apply - for example:

* `28P01` -> check `PG_USER`/`PG_PASSWORD`
* `3D000` -> database does not exist, check `PG_DATABASE`
* `42P01` -> relation not found, call `list_tables`
* `42703` -> column not found, call `describe_table`
* `57014` -> the query was canceled; if it hit `PG_STATEMENT_TIMEOUT`, add a `LIMIT` or simplify it
* `25006` -> the transaction is read-only (its source may be a read-only role, a replica, a server default, or - for `query` - the read-only wrapper; `execute` writes need `PG_ALLOW_WRITE=true`)
* `ECONNREFUSED`/`ENOTFOUND` -> check `PG_HOST`/`PG_PORT`/`DATABASE_URL`

## Migrating from 0.1.x

Not needed for new installs. Two behavior changes since 0.1.x:

1. **Read-only by default.** The `execute` tool is always visible but refuses
   writes (with an error naming the flag) unless `PG_ALLOW_WRITE=true`, and every
   read runs inside an engine-enforced `READ ONLY` transaction. If your workflow
   writes to the database, set `"PG_ALLOW_WRITE": "true"` to restore 0.1.x behavior.
2. **`connect_db` is disabled by default.** Runtime connection switching (passing
   credentials through tool arguments) requires `PG_ENABLE_RUNTIME_CONNECT=true`;
   otherwise connection details come only from the environment.

Tool names, parameter names, and `PG_*` variables are unchanged. Result payloads
are now structured compact JSON for **every** tool (e.g. `query` returns
`{rows, rowCount, returnedRows, truncated}` instead of a bare row array) - see
[CHANGELOG.md](CHANGELOG.md) for the exact shapes before updating anything that
parses tool output.

## License

MIT
