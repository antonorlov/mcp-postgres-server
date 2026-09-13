// Shared error contract: the core and the SSH connector depend on this, not on each other.

export interface DatabaseError {
  message: string;
  code?: string;
  hint?: string;
}

// Fallback hints, used only when the server gives none. 57014/25006 name the condition, not a cause.
const PG_ERROR_HINTS: Record<string, string> = {
  '28P01': 'authentication failed: check PG_USER and PG_PASSWORD',
  '3D000': 'database does not exist: check PG_DATABASE',
  ECONNREFUSED: 'could not reach the database server: check PG_HOST, PG_PORT, or DATABASE_URL',
  ENOTFOUND: 'could not resolve the database host: check PG_HOST, PG_PORT, or DATABASE_URL',
  '42P01': 'relation not found: call list_tables to see the available tables',
  '42703': 'column not found: call describe_table to see the table structure',
  '57014': 'the query was canceled; if it exceeded PG_STATEMENT_TIMEOUT, add a LIMIT or simplify it',
  '25006': 'the transaction is read-only (set by the server, a replica, or - for query - the read-only wrapper)',
};

// A connector-classified failure: stable code and hint; the technical cause is for logs, never serialized.
export class ConnectionError extends Error {
  readonly code: string;
  readonly hint?: string;
  constructor(code: string, message: string, options?: { hint?: string; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ConnectionError';
    this.code = code;
    if (options?.hint !== undefined) this.hint = options.hint;
  }
}

// A ConnectionError passes through; otherwise keep pg's message/code and prefer its server hint. Leaks no cause/stack.
export function classifyError(err: unknown): DatabaseError {
  if (err instanceof ConnectionError) {
    return { message: err.message, code: err.code, ...(err.hint !== undefined ? { hint: err.hint } : {}) };
  }
  let message = String(err);
  let code: string | undefined;
  let serverHint: string | undefined;
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>;
    if (typeof e.message === 'string' && e.message !== '') message = e.message;
    if (typeof e.code === 'string') code = e.code;
    if (typeof e.hint === 'string' && e.hint !== '') serverHint = e.hint;
  }
  const hint = serverHint ?? (code !== undefined ? PG_ERROR_HINTS[code] : undefined);
  return {
    message,
    ...(code !== undefined ? { code } : {}),
    ...(hint !== undefined ? { hint } : {}),
  };
}
