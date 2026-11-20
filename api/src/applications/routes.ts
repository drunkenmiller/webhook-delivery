import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth/admin.ts';
import { generateApiKey } from '../auth/api-keys.ts';
import type { Db } from '../db.ts';
import { withValidation } from '../http/validate.ts';
import { insertApplication } from './repository.ts';

const CreateApplicationBody = z.object({
  name: z.string().trim().min(1).max(200),
});

export function applicationsRouter({ db, adminToken }: { db: Db; adminToken: string }): Router {
  const router = Router();

  // POST /v1/applications (admin) — creates an application and returns its API key ONCE.
  router.post(
    '/v1/applications',
    requireAdmin(adminToken),
    withValidation({ body: CreateApplicationBody }, async ({ body }, _req, res) => {
      const apiKey = generateApiKey();
      const app = await insertApplication(db, {
        name: body.name,
        apiKeyPrefix: apiKey.prefix,
        apiKeyHash: apiKey.hash,
      });
      res.status(201).json({
        id: app.id,
        name: app.name,
        api_key: apiKey.key, // the only time the full key is ever returned
        api_key_prefix: app.api_key_prefix,
        created_at: app.created_at,
      });
    }),
  );

  return router;
}
