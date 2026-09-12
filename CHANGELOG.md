# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-13

> **BREAKING (from 0.1.x):**
>
> 1. **Read-only by default.** Set `PG_ALLOW_WRITE=true` for writes; `execute` stays visible but refuses them until then.
> 2. **`connect_db` requires `PG_ENABLE_RUNTIME_CONNECT=true`** (otherwise not registered).
>
> See "Migrating from 0.1.x" in the README.

### Added

- Engine-enforced read-only: reads run as `BEGIN READ ONLY` + the bound statement + `ROLLBACK`
  (no client-side SQL parsing; PostgreSQL is the boundary). `execute` refuses writes unless
  `PG_ALLOW_WRITE=true`.
- Optional SSH tunneling (`PG_SSH_*`): reach the database through a bastion. Mandatory host-key
  pinning (`PG_SSH_FINGERPRINT`, fail-closed); key / agent / password auth with `ssh`-style
  fallback (`SSH_AUTH_SOCK`, `~/.ssh/id_ed25519`); TLS validated against the real hostname;
  keepalive + lazy reconnect. `ssh2` is an optional dependency, loaded only when configured.
- `DATABASE_URL` support (preferred over `PG_*`), plus `PG_SSLMODE`
  (`disable`|`allow`|`prefer`|`require`|`verify-ca`|`verify-full`) and `PG_SSL_CA`. `allow`/`prefer`
  do not fall back to plaintext; verifying modes pin `rejectUnauthorized`. Full pg options
  (`application_name`, `options`/`search_path`) and IPv6 `[::1]` URLs handled for direct and tunneled
  connections alike.
- Result size cap (`PG_MAX_RESULT_BYTES`, default 32768): whole rows within the byte budget, else
  `returnedRows < rowCount` + `truncated: true` + a refine hint.
- Statement timeout (`PG_STATEMENT_TIMEOUT`, 30000 ms) and connect timeout (`PG_CONNECT_TIMEOUT`,
  10000 ms).
- SQLSTATE-based error hints; stderr warning when connected as a superuser in read-only mode.
- MCP tool annotations per spec 2025-11-25 (`readOnlyHint`/`destructiveHint`/`openWorldHint`).
- Test suite (unit + integration against a real Postgres + tool-surface snapshot) and CI on Node 20/22/24.

### Changed

- **BREAKING:** read-only by default; `query` now accepts `SELECT`/`WITH`/`EXPLAIN`/`SHOW`.
- **BREAKING:** `connect_db` opt-in via `PG_ENABLE_RUNTIME_CONNECT=true`.
- **BREAKING:** result payloads are compact JSON with new shapes:
  - `query`: `{rows, rowCount, returnedRows, truncated}` (was a bare row array);
  - `list_schemas`: `{schemas: [...]}`; `list_tables`: `{tables: [...]}`;
  - `describe_table`: `{columns: [{column, type, nullable, default, is_primary_key}]}`
    (renamed keys, `nullable` a boolean).
- Minimum `pg` `^8.23.0`: `query` pipelines the read and `ROLLBACK` into 2 round-trips (was 3).
- Upgraded `@modelcontextprotocol/sdk` to `^1.29.0`; requires Node >= 20.
- Failures are returned as `isError: true` tool results instead of thrown protocol errors.

### Removed

- The `dotenv` dependency (a `.env` file no longer affects configuration).
- Legacy `?` placeholder conversion; use native `$1`, `$2`.

### Fixed

- Reconnects lazily instead of crashing when the connection drops.
- `connect_db` rejects an out-of-range `port`; an unreachable target no longer hangs queued calls.
- Multi-statement input (`SELECT 1; DROP TABLE x`) is rejected.

### Security

- The connecting role is the real boundary; engine enforcement (rolled-back `BEGIN READ ONLY`) is
  defense-in-depth. No client-side SQL parser; read-only is scoped per transaction, so it holds across
  a transaction pooler like PgBouncer. Full threat model in [SECURITY.md](SECURITY.md).
- Vulnerability disclosure via GitHub private security advisories.

## [0.1.3] and earlier

Releases prior to 0.2.0 predate this changelog.

[0.2.0]: https://github.com/antonorlov/mcp-postgres-server/releases/tag/v0.2.0
