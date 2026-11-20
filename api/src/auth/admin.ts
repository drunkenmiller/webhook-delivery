import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { ProblemError } from '../http/problem.ts';
import { bearerToken, hashApiKey } from './api-keys.ts';

// Protects admin routes with `Authorization: Bearer <ADMIN_TOKEN>`.
export function requireAdmin(adminToken: string): RequestHandler {
  // Comparing SHA-256 digests gives two buffers of the same length (timingSafeEqual requires it)
  // without revealing the token's length through timing.
  const expected = hashApiKey(adminToken);

  return (req, res, next) => {
    const token = bearerToken(req.headers.authorization);
    if (token === undefined || !timingSafeEqual(hashApiKey(token), expected)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      throw new ProblemError({ status: 401, detail: 'A valid admin token is required' });
    }
    next();
  };
}
