import { createHmac, timingSafeEqual } from 'node:crypto';

// Receiver-side verification of the Standard Webhooks signature (https://www.standardwebhooks.com/),
// the scheme our worker uses to sign deliveries (SPEC §5, ADR 0007):
//
//   webhook-id:        msg id (same on every retry)
//   webhook-timestamp: unix seconds of this attempt
//   webhook-signature: "v1,<base64 HMAC-SHA256(secret, `${id}.${timestamp}.${body}`)>"
//                      (may hold several space-separated signatures, e.g. during secret rotation)

export const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export interface VerifyInput {
  secrets: readonly string[]; // any of them may match (lets one receiver serve several endpoints)
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  body: string; // the raw body exactly as received — re-serialized JSON would not match
  nowSeconds: number;
  toleranceSeconds?: number;
}

export function verifyWebhook(input: VerifyInput): VerifyResult {
  const { id, timestamp, signature } = input;
  if (!id || !timestamp || !signature) {
    return { ok: false, reason: 'missing webhook-id, webhook-timestamp or webhook-signature' };
  }
  if (!/^\d{1,12}$/.test(timestamp)) {
    return { ok: false, reason: 'invalid webhook-timestamp' };
  }

  // Replay protection: a captured request can't be re-sent hours later, because the timestamp
  // is part of the signed content and must be recent.
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(input.nowSeconds - Number(timestamp)) > tolerance) {
    return { ok: false, reason: 'webhook-timestamp outside the tolerance window' };
  }

  const provided = signature
    .split(' ')
    .map((part) => part.split(','))
    .filter(([version, value]) => version === 'v1' && value !== undefined)
    .map(([, value]) => Buffer.from(value ?? '', 'base64'));

  for (const secret of input.secrets) {
    const expected = sign(secret, id, timestamp, input.body);
    // timingSafeEqual takes the same time whether the first or the last byte differs, so an
    // attacker can't guess the signature byte by byte by measuring response times.
    // It throws on different lengths, hence the length check first.
    if (provided.some((sig) => sig.length === expected.length && timingSafeEqual(sig, expected))) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'no matching signature' };
}

// HMAC-SHA256 over "{id}.{timestamp}.{body}" with the decoded secret. Exported for tests.
export function sign(secret: string, id: string, timestamp: string, body: string): Buffer {
  const key = Buffer.from(
    secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret,
    'base64',
  );
  return createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();
}
