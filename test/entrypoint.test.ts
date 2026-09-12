// Entry point: main(), isEntryPoint(), bootstrap(). main() takes process + transport as args, so the
// startup path (config, signal handlers, stderr banner, shutdown->exit) runs over an in-memory transport.
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { bootstrap, isEntryPoint, main, stdioTransport, type ProcessLike } from '../src/index.js';

// A ProcessLike that records handlers and resolves a promise on exit().
function fakeProcess(env: Record<string, string> = {}) {
  const handlers: Record<string, () => void> = {};
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (resolveExit = resolve));
  const proc: ProcessLike = {
    env,
    on: (event, handler) => (handlers[event] = handler),
    stdin: { on: (event, handler) => (handlers[`stdin:${event}`] = handler) },
    exit: (code) => resolveExit(code),
  };
  return { proc, handlers, exited };
}

describe('main', () => {
  afterEach(() => vi.restoreAllMocks());

  it('serves the tool surface from env config, logs a read-only banner, and exits 0 on SIGINT', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { proc, handlers, exited } = fakeProcess({ DATABASE_URL: 'postgres://u:p@h:5432/d' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await main(proc, serverTransport);

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[postgres-server\] v\d+\.\d+\.\d+ running on stdio in read-only mode/));
    expect(Object.keys(handlers).sort()).toEqual(['SIGINT', 'SIGTERM', 'stdin:close']);

    const client = new McpClient({ name: 'entrypoint-test', version: '0.0.0' });
    await client.connect(clientTransport);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(['describe_table', 'execute', 'list_schemas', 'list_tables', 'query']);
    await client.close();

    handlers.SIGINT();
    await expect(exited).resolves.toBe(0);
  });

  it('logs READ-WRITE and runtime connect in the banner when both are enabled, and exits 0 when stdin closes', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { proc, handlers, exited } = fakeProcess({
      DATABASE_URL: 'postgres://u:p@h:5432/d',
      PG_ALLOW_WRITE: 'true',
      PG_ENABLE_RUNTIME_CONNECT: 'true',
    });
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    await main(proc, serverTransport);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/READ-WRITE mode; runtime connect_db enabled$/));
    handlers['stdin:close']();
    await expect(exited).resolves.toBe(0);
  });

  it('selects the SSH connector when PG_SSH_HOST is set, still serving the tool surface', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // PG_SSH_HOST routes through the optional ssh-connector (loaded lazily); listing tools never
    // opens the tunnel, so no bastion is needed to prove main wires the connector in.
    const { proc, handlers, exited } = fakeProcess({ DATABASE_URL: 'postgres://u:p@h:5432/d', PG_SSH_HOST: 'bastion', PG_SSH_FINGERPRINT: 'SHA256:x' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await main(proc, serverTransport);
    const client = new McpClient({ name: 'entrypoint-ssh-test', version: '0.0.0' });
    await client.connect(clientTransport);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('query');
    await client.close();
    handlers.SIGINT();
    await expect(exited).resolves.toBe(0);
  });

  it('still exits 0 when closing the transport fails (SIGTERM path)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { proc, handlers, exited } = fakeProcess({ DATABASE_URL: 'postgres://u:p@h:5432/d' });
    const brokenTransport: Transport = {
      start: async () => undefined,
      send: async () => undefined,
      close: async () => {
        throw new Error('close failed');
      },
    };
    await main(proc, brokenTransport);
    handlers.SIGTERM();
    await expect(exited).resolves.toBe(0);
  });
});

describe('isEntryPoint', () => {
  // realpath: on macOS tmpdir is itself a symlink, and import.meta.url is always the resolved path.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-entry-')));
  const real = join(dir, 'index.js');
  const link = join(dir, 'mcp-postgres'); // what an npm bin stub looks like
  writeFileSync(real, '');
  symlinkSync(real, link);

  it('is false without an argv[1]', () => {
    expect(isEntryPoint(undefined, pathToFileURL(real).href)).toBe(false);
    expect(isEntryPoint('', pathToFileURL(real).href)).toBe(false);
  });

  it('is true when argv[1] is the module itself', () => {
    expect(isEntryPoint(real, pathToFileURL(real).href)).toBe(true);
  });

  it('is true when argv[1] is a symlink to the module (npm bin stub)', () => {
    expect(isEntryPoint(link, pathToFileURL(real).href)).toBe(true);
  });

  it('is false for another existing file, and for a path that does not exist', () => {
    expect(isEntryPoint(real, 'file:///somewhere/else.js')).toBe(false);
    expect(isEntryPoint(join(dir, 'missing.js'), pathToFileURL(real).href)).toBe(false);
  });

  it('cleanup', () => rmSync(dir, { recursive: true, force: true }));
});

describe('bootstrap', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does nothing when the module is merely imported', () => {
    const { proc, handlers } = fakeProcess();
    const makeTransport = vi.fn<() => Transport>();
    bootstrap('/not/this/module.js', 'file:///src/index.js', proc, makeTransport);
    expect(makeTransport).not.toHaveBeenCalled();
    expect(handlers).toEqual({});
  });

  it('runs main() when executed directly', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { proc, handlers, exited } = fakeProcess({ DATABASE_URL: 'postgres://u:p@h:5432/d' });
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    bootstrap('/app/index.js', 'file:///app/index.js', proc, () => serverTransport);
    await vi.waitFor(() => expect(handlers.SIGINT).toBeDefined());
    handlers.SIGINT();
    await expect(exited).resolves.toBe(0);
  });

  it('logs a fatal error and exits 1 when startup fails (bad config)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { proc, exited } = fakeProcess({ PG_SSLMODE: 'verify_full' }); // typo -> loadConfig throws
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    bootstrap('/app/index.js', 'file:///app/index.js', proc, () => serverTransport);
    await expect(exited).resolves.toBe(1);
    expect(log).toHaveBeenCalledWith('[postgres-server] fatal:', expect.objectContaining({ message: expect.stringMatching(/unrecognized sslmode/) }));
  });

  it('the production transport factory builds a stdio transport (constructing it does not touch stdin)', () => {
    expect(stdioTransport()).toBeInstanceOf(StdioServerTransport);
  });
});
