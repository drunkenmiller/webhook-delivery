import { describe, expect, it } from 'vitest';
import { isPrivateTarget } from '../src/endpoints/url-safety.ts';

describe('isPrivateTarget', () => {
  it.each([
    'http://localhost:4000/hook',
    'http://LOCALHOST./hook', // case and trailing dot
    'http://api.localhost/hook',
    'http://127.0.0.1/hook',
    'http://127.1.2.3/hook',
    'http://2130706433/hook', // 127.0.0.1 written as one decimal number
    'http://0x7f.1/hook', // 127.0.0.1 in hex shorthand
    'http://0.0.0.0/hook',
    'http://10.1.2.3/hook',
    'http://172.16.0.1/hook',
    'http://172.31.255.255/hook',
    'http://192.168.1.10/hook',
    'http://169.254.169.254/latest/meta-data/', // cloud metadata service
    'http://100.64.0.1/hook',
    'http://224.0.0.1/hook',
    'http://255.255.255.255/hook',
    'http://[::1]:4000/hook',
    'http://[::]/hook',
    'http://[fd12:3456::1]/hook',
    'http://[fe80::1]/hook',
    'http://[::ffff:127.0.0.1]/hook', // IPv4-mapped IPv6
    'http://[::ffff:10.0.0.1]/hook',
  ])('blocks %s', (url) => {
    expect(isPrivateTarget(new URL(url))).toBe(true);
  });

  it.each([
    'https://example.com/hook',
    'https://hooks.acme.io:8443/in',
    'https://8.8.8.8/hook',
    'https://172.32.0.1/hook', // just outside 172.16.0.0/12
    'https://192.169.0.1/hook',
    'https://[2001:4860:4860::8888]/hook',
    'https://localhost.example.com/hook', // only *.localhost is special, not localhost.*
  ])('allows %s', (url) => {
    expect(isPrivateTarget(new URL(url))).toBe(false);
  });
});
