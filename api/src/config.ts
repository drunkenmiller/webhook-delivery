import { z } from 'zod';

// Every setting comes from environment variables (see ../.env.example).
// Parsing them once at startup with zod means the rest of the code gets typed values
// and the process fails fast with a clear message when something is missing or invalid.
const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  // Bearer token for admin routes (POST /v1/applications). Long and random, e.g. `openssl rand -hex 32`.
  ADMIN_TOKEN: z.string().min(16),
  // Allow endpoint URLs on private/loopback addresses (e.g. http://localhost:4000). Defaults to
  // true outside production so local demos work; see endpoints/url-safety.ts.
  ALLOW_PRIVATE_TARGETS: z.stringbool().optional(),
  // Comma-separated browser origins allowed by CORS, e.g. "http://localhost:5173" (the dashboard).
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin !== ''),
    )
    .pipe(
      z.array(
        // An origin is scheme://host[:port] — no path, no trailing slash.
        z
          .string()
          .refine(
            (origin) => URL.canParse(origin) && new URL(origin).origin === origin,
            'must be an origin like https://dashboard.example.com (no path, no trailing slash)',
          ),
      ),
    ),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
