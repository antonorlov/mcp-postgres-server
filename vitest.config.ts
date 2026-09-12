import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration tests talk to a real Postgres (PG_TEST_URL); give them headroom.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // ssh-connector is I/O glue (sockets, ssh2 forwarding, pg over a tunnel): its logic is unit-tested
      // with injected fakes and its real wiring is proven by the stand's SSH-bastion E2E, neither of which
      // a coverage % would capture. Excluded so it does not force over-mocked tests onto the core's bar.
      exclude: ['src/ssh-connector.ts'],
      // 100% is the bar for the core, and CI enforces it. Run with PG_TEST_URL set: the
      // integration suite covers the paths that only a real engine exercises.
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
