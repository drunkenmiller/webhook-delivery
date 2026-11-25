import { describe, expect, it } from 'vitest';
import { canonicalJson, hashRequest } from '../src/messages/request-hash.ts';

describe('canonicalJson', () => {
  it('sorts object keys at every level and removes whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('keeps array order and escapes strings like JSON.stringify', () => {
    expect(canonicalJson([2, 1, 'a"b'])).toBe('[2,1,"a\\"b"]');
  });

  it('drops undefined fields, like JSON.stringify', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe('hashRequest', () => {
  it('is the same for the same content in any key order', () => {
    const a = hashRequest({ event_type: 'x', payload: { a: 1, b: 2 } });
    const b = hashRequest({ payload: { b: 2, a: 1 }, event_type: 'x' });
    expect(a.equals(b)).toBe(true);
    expect(a).toHaveLength(32);
  });

  it('differs when the content differs', () => {
    const a = hashRequest({ event_type: 'x', payload: { a: 1 } });
    const b = hashRequest({ event_type: 'x', payload: { a: 2 } });
    expect(a.equals(b)).toBe(false);
  });
});
