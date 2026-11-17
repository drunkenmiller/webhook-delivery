import { randomBytes } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { describe, expect, it } from 'vitest';
import { sign, verifyWebhook } from '../src/signature.ts';

const secret = `whsec_${randomBytes(32).toString('base64')}`;
const id = 'msg_0193a1b2c3d4';
const body = '{"invoice":"inv_1","amount":4200}';
const now = 1_800_000_000;
const timestamp = String(now);

function header(s = secret, ts = timestamp, b = body): string {
  return `v1,${sign(s, id, ts, b).toString('base64')}`;
}

describe('verifyWebhook', () => {
  const base = { secrets: [secret], id, timestamp, body, nowSeconds: now };

  it('accepts a valid signature', () => {
    expect(verifyWebhook({ ...base, signature: header() })).toEqual({ ok: true });
  });

  it('rejects a tampered body', () => {
    const result = verifyWebhook({ ...base, signature: header(), body: body.replace('4200', '1') });
    expect(result).toEqual({ ok: false, reason: 'no matching signature' });
  });

  it('rejects a signature made with another secret', () => {
    const other = `whsec_${randomBytes(32).toString('base64')}`;
    expect(verifyWebhook({ ...base, signature: header(other) }).ok).toBe(false);
  });

  it('rejects timestamps older or newer than 5 minutes', () => {
    const old = String(now - 301);
    expect(verifyWebhook({ ...base, timestamp: old, signature: header(secret, old) })).toEqual({
      ok: false,
      reason: 'webhook-timestamp outside the tolerance window',
    });
    const future = String(now + 301);
    expect(
      verifyWebhook({ ...base, timestamp: future, signature: header(secret, future) }).ok,
    ).toBe(false);
  });

  it('accepts when any of several signatures matches (secret rotation)', () => {
    const signature = `v1,${Buffer.alloc(32).toString('base64')} ${header()}`;
    expect(verifyWebhook({ ...base, signature }).ok).toBe(true);
  });

  it('accepts when the matching secret is any of several configured', () => {
    const other = `whsec_${randomBytes(32).toString('base64')}`;
    expect(verifyWebhook({ ...base, secrets: [other, secret], signature: header() }).ok).toBe(true);
  });

  it('rejects missing headers and unknown versions', () => {
    expect(verifyWebhook({ ...base, signature: undefined }).ok).toBe(false);
    expect(verifyWebhook({ ...base, id: undefined, signature: header() }).ok).toBe(false);
    expect(verifyWebhook({ ...base, signature: header().replace('v1,', 'v2,') }).ok).toBe(false);
    expect(verifyWebhook({ ...base, timestamp: 'abc', signature: header() }).ok).toBe(false);
  });
});

// Interoperability: signatures produced by the official Standard Webhooks library must verify
// here, and ours must verify there. This is what lets real receivers use off-the-shelf libraries.
describe('compatibility with the official standardwebhooks library', () => {
  const official = new Webhook(secret);

  it('verifies a signature produced by the official library', () => {
    const signedAt = new Date(now * 1000);
    const signature = official.sign(id, signedAt, body);
    expect(
      verifyWebhook({ secrets: [secret], id, timestamp, body, nowSeconds: now, signature }),
    ).toEqual({
      ok: true,
    });
  });

  it('produces signatures the official library accepts', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = {
      'webhook-id': id,
      'webhook-timestamp': ts,
      'webhook-signature': header(secret, ts),
    };
    expect(official.verify(body, headers)).toEqual(JSON.parse(body));
  });
});
