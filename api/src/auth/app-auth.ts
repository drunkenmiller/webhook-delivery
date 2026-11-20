import { timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { findApplicationByKeyPrefix } from '../applications/repository.ts';
import type { Db } from '../db.ts';
import { ProblemError } from '../http/problem.ts';
import { bearerToken, hashApiKey, parseApiKeyPrefix } from './api-keys.ts';

export interface AuthenticatedApp {
  id: string;
  name: string;
}

// Authenticates `Authorization: Bearer whd_<prefix>_<secret>`:
//   1. the public prefix finds the application (one indexed lookup, UNIQUE api_key_prefix);
//   2. SHA-256 of the presented key is compared in constant time with the stored hash.
// Every failure gives the same 401, so a caller can't tell "unknown key" from "wrong secret".
export function authenticateApp(db: Db): RequestHandler {
  return async (req, res, next) => {
    const token = bearerToken(req.headers.authorization);
    const prefix = token === undefined ? undefined : parseApiKeyPrefix(token);
    const app = prefix === undefined ? undefined : await findApplicationByKeyPrefix(db, prefix);

    if (
      token === undefined ||
      app === undefined ||
      !timingSafeEqual(hashApiKey(token), app.api_key_hash)
    ) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      throw new ProblemError({ status: 401, detail: 'A valid API key is required' });
    }

    req.authApp = { id: app.id, name: app.name };
    next();
  };
}

// For handlers behind authenticateApp. Missing = the route was wired without the middleware,
// which is a programming error, hence 500 and not 401.
export function authenticatedApp(req: Request): AuthenticatedApp {
  if (req.authApp === undefined) {
    throw new Error('authenticateApp middleware is missing on this route');
  }
  return req.authApp;
}
