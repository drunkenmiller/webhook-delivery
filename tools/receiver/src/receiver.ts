import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { verifyWebhook } from './signature.ts';

// A fake customer endpoint for demos and end-to-end tests. Any POST path receives webhooks.
// Behaviour can be chosen per endpoint through query parameters in the endpoint URL itself:
//
//   http://receiver:4000/hook?status=503        always answer 503
//   http://receiver:4000/hook?fail_rate=0.3     answer 500 to ~30% of the requests
//   http://receiver:4000/hook?delay_ms=15000    wait 15 s before answering (worker timeout test)
//
// GET /stats returns counters, including duplicates: webhook-ids acknowledged (2xx) more than
// once — the visible cost of at-least-once delivery (ADR 0003).

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_DELAY_MS = 120_000;

export interface ReceiverOptions {
  secrets: readonly string[]; // empty = accept unsigned requests (signature not checked)
  nowSeconds: () => number;
  random: () => number; // injectable so tests can force the fail_rate outcome
  sleep: (ms: number) => Promise<void>; // injectable so tests don't really wait
  log: (entry: Record<string, unknown>) => void;
}

export interface ReceiverStats {
  received: number; // every POST
  rejected: number; // invalid or missing signature (401)
  failed: number; // simulated failures (non-2xx on purpose)
  acknowledged: number; // answered 2xx
  unique: number; // distinct webhook-ids acknowledged
  duplicates: number; // acknowledged again for an id that was already acknowledged
}

export function createReceiver(options: ReceiverOptions): RequestListener {
  const stats: ReceiverStats = {
    received: 0,
    rejected: 0,
    failed: 0,
    acknowledged: 0,
    unique: 0,
    duplicates: 0,
  };
  const acknowledgedIds = new Set<string>();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://receiver');

    if (req.method === 'GET' && url.pathname === '/healthz') {
      return sendJson(res, 200, { status: 'ok' });
    }
    if (req.method === 'GET' && url.pathname === '/stats') {
      return sendJson(res, 200, stats);
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    const body = await readBody(req, MAX_BODY_BYTES);
    if (body === null) {
      return sendJson(res, 413, { error: 'body too large' });
    }
    stats.received++;

    const id = headerValue(req, 'webhook-id');
    const entry: Record<string, unknown> = { path: url.pathname, webhook_id: id };

    if (options.secrets.length > 0) {
      const result = verifyWebhook({
        secrets: options.secrets,
        id,
        timestamp: headerValue(req, 'webhook-timestamp'),
        signature: headerValue(req, 'webhook-signature'),
        body,
        nowSeconds: options.nowSeconds(),
      });
      if (!result.ok) {
        stats.rejected++;
        options.log({ ...entry, status: 401, rejected: result.reason });
        return sendJson(res, 401, { error: result.reason });
      }
    }

    const delayMs = Math.min(intParam(url, 'delay_ms') ?? 0, MAX_DELAY_MS);
    if (delayMs > 0) {
      await options.sleep(delayMs);
    }

    const status = chooseStatus(url, options.random);
    if (status >= 200 && status < 300) {
      stats.acknowledged++;
      const duplicate = id !== undefined && acknowledgedIds.has(id);
      if (duplicate) {
        stats.duplicates++;
      } else {
        stats.unique++;
        if (id !== undefined) acknowledgedIds.add(id);
      }
      entry.duplicate = duplicate;
    } else {
      stats.failed++;
    }

    options.log({ ...entry, status, delay_ms: delayMs, bytes: Buffer.byteLength(body) });
    sendJson(res, status, { received: status >= 200 && status < 300 });
  }

  // node:http ignores the promise returned by a listener, so errors are caught here.
  return (req, res) => {
    handle(req, res).catch((err: unknown) => {
      options.log({ error: String(err) });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
  };
}

function chooseStatus(url: URL, random: () => number): number {
  const forced = intParam(url, 'status');
  if (forced !== undefined && forced >= 200 && forced <= 599) {
    return forced;
  }
  const failRate = Number(url.searchParams.get('fail_rate') ?? 0);
  if (failRate > 0 && random() < failRate) {
    return 500;
  }
  return 200;
}

function intParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || !/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

// Reads the raw body as text. Keeps reading (but stops storing) past the limit so the
// connection stays usable, then reports "too large" with null.
async function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= limit) chunks.push(chunk);
  }
  return size > limit ? null : Buffer.concat(chunks).toString('utf8');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
