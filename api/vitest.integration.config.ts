import { defineConfig } from 'vitest/config';

// Integration tests run against a real PostgreSQL 18 started in Docker by Testcontainers.
// Requires a running Docker engine (GitHub's Ubuntu runners have one).
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    // Runs once before all test files: starts the database and applies the migrations.
    globalSetup: ['test/integration/global-setup.ts'],
    // Pulling the image and starting the container can take a while on the first run.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
