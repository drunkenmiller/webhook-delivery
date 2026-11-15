import { pino, type Logger } from 'pino';
import type { Config } from './config.ts';

// Structured JSON logs (one JSON object per line). In development the output is piped through
// pino-pretty for readability; in production the raw JSON goes to stdout for the platform to collect.
export function createLogger(config: Pick<Config, 'NODE_ENV' | 'LOG_LEVEL'>): Logger {
  return pino({
    level: config.LOG_LEVEL,
    // Never write credentials to the logs (SPEC N6).
    redact: ['req.headers.authorization', 'req.headers["idempotency-key"]'],
    ...(config.NODE_ENV === 'development' && { transport: { target: 'pino-pretty' } }),
  });
}
