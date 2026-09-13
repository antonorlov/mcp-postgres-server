# Security Policy

## Reporting a vulnerability

Report privately via
[GitHub security advisories](https://github.com/antonorlov/mcp-postgres-server/security/advisories/new)
("Security" tab -> "Report a vulnerability"). Do **not** open a public issue.

## The real boundary is the database role

Read-only mode is **defense-in-depth, not a security boundary.** Client-side SQL
filtering can never be a guarantee; the only real boundary is the privileges of
the role you connect with. Prefer a least-privilege role:

```sql
CREATE ROLE mcp_readonly LOGIN PASSWORD 'change-me';
GRANT CONNECT ON DATABASE your_database TO mcp_readonly;
GRANT pg_read_all_data TO mcp_readonly;                          -- PG 14+
ALTER ROLE mcp_readonly SET default_transaction_read_only = on;
```

On PG 13 or older, grant `SELECT ON ALL TABLES` in the schema and set matching
`ALTER DEFAULT PRIVILEGES` instead of `pg_read_all_data`.

A dedicated role is not required (existing credentials work), but avoid
`superuser` / `rds_superuser` / `pg_execute_server_program` - they write
regardless of grants; the server warns on stderr if you connect as a superuser.
Read grants don't revoke other privileges; ownership, `PUBLIC` grants, and
`SECURITY DEFINER` functions also matter.

## How read-only is enforced

No client-side SQL parsing - PostgreSQL is the enforcer. In read-only mode
(default) every `query` runs as `BEGIN READ ONLY` + the bound statement (extended
protocol, one command only) + `ROLLBACK`. The engine refuses any write with
SQLSTATE 25006 - including a write hidden in a view, rule, or function - and
reverts any session change; this holds even for a write-capable role. With
`PG_ALLOW_WRITE=true` statements are sent directly and the role alone governs
writes. `statement_timeout` and `idle_in_transaction_session_timeout` are set on
connect (a pooler may not preserve them; the driver's `query_timeout` is the
backstop).

## Threat model

**Stops:** a confused or prompt-injected model *writing* to your database
(`DROP`/`DELETE`/`UPDATE`/`INSERT`, and exfiltration-by-write).

**Does NOT stop: prompt injection via returned rows.** Anything a `SELECT`
returns becomes model context; adversarial text in a row is not filtered, and
with another tool that can reach the network it can still be exfiltrated. Limit
what the role can `SELECT`, and be deliberate about which tools run alongside
this one.

**Do not point this server at production.** Use a replica, a snapshot, a dev
copy, or a role scoped to the exact tables the task needs.

## Scope

- `connect_db` (runtime credential switching) is disabled unless
  `PG_ENABLE_RUNTIME_CONNECT=true`; otherwise credentials come only from the
  environment, never from the model.
- Local stdio server only - no HTTP transport, tokens, or OAuth, so
  remote-MCP attacks do not apply.

## SSH tunneling (optional, `PG_SSH_HOST`)

- **Host-key verification is mandatory and fail-closed:** a pinned
  `PG_SSH_FINGERPRINT` must match, or the tunnel refuses to connect (a
  man-in-the-middle bastion is rejected).
- **Database TLS is verified end-to-end:** with `verify-full` the certificate is
  checked against the real hostname, not the loopback the tunnel binds, and
  `rejectUnauthorized` is pinned on against an inherited
  `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- Credentials (SSH key/password, DB password) come from the environment; `ssh2`
  loads only when `PG_SSH_HOST` is set. The exception: with `connect_db` enabled
  (`PG_ENABLE_RUNTIME_CONNECT=true`), its DB password is passed as a tool argument.
