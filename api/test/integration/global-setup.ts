import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { applyMigrations } from './migrations.ts';

// Tell TypeScript what `inject('databaseUrl')` returns inside the tests.
declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

// Vitest runs this once, before any integration test file. It starts a throwaway PostgreSQL
// container (same image as docker-compose.yml), applies the migrations and shares the
// connection URL with the tests. The returned function runs after all tests: it removes
// the container, so every run starts from an empty database.
export default async function setup({ provide }: TestProject) {
  const container = await new PostgreSqlContainer('postgres:18-alpine').start();
  const databaseUrl = container.getConnectionUri();

  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await applyMigrations(pool);
  } finally {
    await pool.end();
  }

  provide('databaseUrl', databaseUrl);

  return async () => {
    await container.stop();
  };
}
