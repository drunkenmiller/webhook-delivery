import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyMigrations, extractUpSection } from './integration/migrations.ts';

describe('extractUpSection', () => {
  it('returns only the up section', () => {
    const sql = '-- migrate:up\nCREATE TABLE t (id int);\n\n-- migrate:down\nDROP TABLE t;\n';
    expect(extractUpSection(sql)).toBe('CREATE TABLE t (id int);');
  });

  it('accepts dbmate options and a missing down section', () => {
    const sql = '-- migrate:up transaction:false\nCREATE INDEX CONCURRENTLY i ON t (id);\n';
    expect(extractUpSection(sql)).toBe('CREATE INDEX CONCURRENTLY i ON t (id);');
  });

  it('rejects a file without an up section', () => {
    expect(() => extractUpSection('SELECT 1;')).toThrow(/migrate:up/);
  });
});

describe('applyMigrations', () => {
  it('runs .sql files in filename order and ignores other files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'migrations-'));
    await writeFile(join(dir, '20260102000000_second.sql'), '-- migrate:up\nSELECT 2;\n');
    await writeFile(join(dir, '20260101000000_first.sql'), '-- migrate:up\nSELECT 1;\n');
    await writeFile(join(dir, 'README.md'), 'not a migration');

    const executed: string[] = [];
    const fakeClient = {
      query: (sql: string) => {
        executed.push(sql);
        return Promise.resolve();
      },
    };

    const files = await applyMigrations(fakeClient, dir);
    expect(files).toEqual(['20260101000000_first.sql', '20260102000000_second.sql']);
    expect(executed).toEqual(['SELECT 1;', 'SELECT 2;']);
  });
});
