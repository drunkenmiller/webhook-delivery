import { z } from 'zod';
import { ProblemError } from './problem.ts';

// Keyset ("cursor") pagination shared by every list route (SPEC §6):
//   ?limit=1..100 (default 20) & ?cursor=<opaque>  →  { data: [...], next_cursor: string | null }
//
// The cursor is "opaque": clients pass it back without interpreting it, so its format (today
// base64url of the last row's uuidv7 id) can change later without breaking anyone.

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

export function encodeCursor(id: string): string {
  return Buffer.from(id).toString('base64url');
}

// undefined cursor → first page. A cursor that doesn't decode to a uuid → 400.
export function decodeCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!z.uuid().safeParse(id).success) {
    throw new ProblemError({ status: 400, type: 'invalid-cursor', detail: 'Invalid cursor' });
  }
  return id;
}

// Repositories are asked for limit + 1 rows: the extra row only says "there is a next page".
export function toPage<Row extends { id: string }, Out>(
  rows: Row[],
  limit: number,
  toResponse: (row: Row) => Out,
): { data: Out[]; next_cursor: string | null } {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    data: page.map(toResponse),
    next_cursor: rows.length > limit && last ? encodeCursor(last.id) : null,
  };
}
