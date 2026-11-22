import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { authenticateApp, authenticatedApp } from '../auth/app-auth.ts';
import type { Db } from '../db.ts';
import { ProblemError } from '../http/problem.ts';
import { withValidation } from '../http/validate.ts';
import { isPrivateTarget } from './url-safety.ts';
import {
  deactivateEndpoint,
  findEndpoint,
  insertEndpoint,
  listEndpoints,
  updateEndpoint,
  type EndpointRow,
} from './repository.ts';

export interface EndpointsRouterOptions {
  db: Db;
  // https:// is required in production; http:// is allowed in development (SPEC §3).
  allowHttpUrls: boolean;
  // Private/loopback destinations are rejected unless this is true (SSRF guard, SPEC §10).
  allowPrivateTargets: boolean;
}

const EventType = z.string().regex(/^[a-z0-9_.-]{1,64}$/, 'must match ^[a-z0-9_.-]{1,64}$');
const IdParams = z.object({ id: z.uuid() });

export function endpointsRouter({
  db,
  allowHttpUrls,
  allowPrivateTargets,
}: EndpointsRouterOptions): Router {
  const router = Router();
  const EndpointUrl = z
    .url({ protocol: allowHttpUrls ? /^https?$/ : /^https$/ })
    .max(2048)
    // zod 4 still runs a refinement when an earlier check on the same string failed (to report
    // every issue at once), so an invalid URL can reach here: canParse() keeps new URL() from
    // throwing, and z.url() has already reported that error.
    .refine(
      (url) => allowPrivateTargets || !URL.canParse(url) || !isPrivateTarget(new URL(url)),
      'must not point to a private, loopback or link-local address',
    );

  // strictObject: unknown fields (e.g. "secret") are rejected instead of silently ignored.
  const CreateBody = z.strictObject({
    url: EndpointUrl,
    event_types: z.array(EventType).max(50).default([]),
    active: z.boolean().default(true),
  });
  const UpdateBody = z
    .strictObject({
      url: EndpointUrl.optional(),
      event_types: z.array(EventType).max(50).optional(),
      active: z.boolean().optional(),
    })
    .refine((body) => Object.keys(body).length > 0, 'provide at least one field to update');
  const ListQuery = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().optional(),
  });

  // Every /v1/endpoints route requires an application API key.
  router.use('/v1/endpoints', authenticateApp(db));

  // POST /v1/endpoints — the signing secret is returned only here, once.
  router.post(
    '/v1/endpoints',
    withValidation({ body: CreateBody }, async ({ body }, req, res) => {
      const endpoint = await insertEndpoint(db, {
        appId: authenticatedApp(req).id,
        url: body.url,
        secret: `whsec_${randomBytes(32).toString('base64')}`,
        eventTypes: body.event_types,
        active: body.active,
      });
      res.status(201).json({ ...toResponse(endpoint), secret: endpoint.secret });
    }),
  );

  // GET /v1/endpoints?limit=&cursor= — newest first, opaque cursor.
  router.get(
    '/v1/endpoints',
    withValidation({ query: ListQuery }, async ({ query }, req, res) => {
      // Ask for one extra row: if it exists, there is a next page.
      const rows = await listEndpoints(db, authenticatedApp(req).id, {
        limit: query.limit + 1,
        afterId: query.cursor === undefined ? undefined : decodeCursor(query.cursor),
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      res.json({
        data: page.map(toResponse),
        next_cursor: rows.length > query.limit && last ? encodeCursor(last.id) : null,
      });
    }),
  );

  router.get(
    '/v1/endpoints/:id',
    withValidation({ params: IdParams }, async ({ params }, req, res) => {
      const endpoint = await findEndpoint(db, authenticatedApp(req).id, params.id);
      if (endpoint === undefined) throw notFound();
      res.json(toResponse(endpoint));
    }),
  );

  router.patch(
    '/v1/endpoints/:id',
    withValidation({ params: IdParams, body: UpdateBody }, async ({ params, body }, req, res) => {
      const endpoint = await updateEndpoint(db, authenticatedApp(req).id, params.id, {
        url: body.url,
        eventTypes: body.event_types,
        active: body.active,
      });
      if (endpoint === undefined) throw notFound();
      res.json(toResponse(endpoint));
    }),
  );

  // DELETE = deactivate (soft delete).
  router.delete(
    '/v1/endpoints/:id',
    withValidation({ params: IdParams }, async ({ params }, req, res) => {
      const found = await deactivateEndpoint(db, authenticatedApp(req).id, params.id);
      if (!found) throw notFound();
      res.status(204).end();
    }),
  );

  return router;
}

// The public shape of an endpoint. The secret is deliberately left out (SPEC N6).
function toResponse(row: EndpointRow) {
  return {
    id: row.id,
    url: row.url,
    event_types: row.event_types,
    active: row.active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function notFound(): ProblemError {
  return new ProblemError({ status: 404, detail: 'Endpoint not found' });
}

// The cursor is "opaque": clients pass it back without interpreting it, so its format
// (today base64url of the last id) can change later without breaking anyone.
function encodeCursor(id: string): string {
  return Buffer.from(id).toString('base64url');
}

function decodeCursor(cursor: string): string {
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!z.uuid().safeParse(id).success) {
    throw new ProblemError({ status: 400, type: 'invalid-cursor', detail: 'Invalid cursor' });
  }
  return id;
}
