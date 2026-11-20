import type { AuthenticatedApp } from '../auth/app-auth.ts';

// "Module augmentation": adds our own field to Express's Request type, so after the
// authenticateApp middleware ran, handlers can read `req.authApp` with full typing.
declare global {
  namespace Express {
    interface Request {
      authApp?: AuthenticatedApp;
    }
  }
}

export {};
