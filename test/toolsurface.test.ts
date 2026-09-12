// Tool-surface tests: what the model can see IS the security posture. execute is always registered
// but refuses in read-only mode; connect_db only with PG_ENABLE_RUNTIME_CONNECT=true. The listTools()
// snapshot is a diffable artifact. The connector throws: listing tools must never touch the database.
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, loadConfig, type Connector, type ServerConfig } from '../src/index.js';

const throwingConnector: Connector = {
  connect: () => {
    throw new Error('tool listing must not connect to the database');
  },
};

async function listToolsFor(config: ServerConfig) {
  const server = createServer(config, throwingConnector);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'toolsurface-test', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await client.listTools();
  } finally {
    await client.close();
    await server.close();
  }
}

const DEFAULT_SURFACE = ['describe_table', 'execute', 'list_schemas', 'list_tables', 'query'];
const FULL_SURFACE = [
  'connect_db',
  'describe_table',
  'execute',
  'list_schemas',
  'list_tables',
  'query',
];

describe('tool surface (registration-time gating)', () => {
  it('default config registers the read tools plus execute (discoverable, refuses writes) - no connect_db', async () => {
    const { tools } = await listToolsFor(loadConfig({}));
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(DEFAULT_SURFACE);
    expect(names).toContain('execute'); // present so writes are discoverable; refuses until PG_ALLOW_WRITE=true
    expect(names).not.toContain('connect_db');
  });

  it('readOnly:false + allowRuntimeConnect:true registers all six tools', async () => {
    const { tools } = await listToolsFor(
      loadConfig({ PG_ALLOW_WRITE: 'true', PG_ENABLE_RUNTIME_CONNECT: 'true' })
    );
    expect(tools.map((t) => t.name).sort()).toEqual(FULL_SURFACE);
  });

  it('execute is always present; PG_ALLOW_WRITE changes its behavior, not the tool set', async () => {
    const ro = (await listToolsFor(loadConfig({}))).tools.map((t) => t.name);
    const rw = (await listToolsFor(loadConfig({ PG_ALLOW_WRITE: 'true' }))).tools.map((t) => t.name);
    expect(ro).toContain('execute');
    expect(rw).toContain('execute');
    expect(rw).not.toContain('connect_db');
  });

  it('annotates tools honestly: query follows the mode, execute is destructive, connect_db is open-world', async () => {
    const { tools } = await listToolsFor(
      loadConfig({ PG_ALLOW_WRITE: 'true', PG_ENABLE_RUNTIME_CONNECT: 'true' })
    );
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    // Introspection tools are always read-only (fixed SQL).
    for (const read of ['list_schemas', 'list_tables', 'describe_table']) {
      expect(byName[read].annotations?.readOnlyHint, `${read}.readOnlyHint`).toBe(true);
      expect(byName[read].annotations?.openWorldHint, `${read}.openWorldHint`).toBe(false);
    }

    // query is sent directly with PG_ALLOW_WRITE=true, so it can write - readOnlyHint must say so.
    expect(byName.query.annotations?.readOnlyHint).toBe(false);
    expect(byName.query.annotations?.openWorldHint).toBe(false);

    expect(byName.execute.annotations?.readOnlyHint).toBe(false);
    expect(byName.execute.annotations?.destructiveHint).toBe(true);
    expect(byName.execute.annotations?.idempotentHint).toBe(false);
    expect(byName.execute.annotations?.openWorldHint).toBe(false);

    expect(byName.connect_db.annotations?.readOnlyHint).toBe(false);
    expect(byName.connect_db.annotations?.openWorldHint).toBe(true);
  });

  it('query is read-only (readOnlyHint true) in the default read-only mode', async () => {
    const { tools } = await listToolsFor(loadConfig({}));
    const query = tools.find((t) => t.name === 'query');
    expect(query?.annotations?.readOnlyHint).toBe(true);
  });

  it('read-only (default) tool surface matches the snapshot', async () => {
    expect(await listToolsFor(loadConfig({}))).toMatchSnapshot();
  });

  it('full (write + runtime connect) tool surface matches the snapshot', async () => {
    expect(
      await listToolsFor(loadConfig({ PG_ALLOW_WRITE: 'true', PG_ENABLE_RUNTIME_CONNECT: 'true' }))
    ).toMatchSnapshot();
  });
});
