import { defineConfig } from 'vitest/config';

// Unit and HTTP tests: fast, no Docker. Integration tests have their own config
// (vitest.integration.config.ts) because they need a real PostgreSQL.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**'],
  },
});
