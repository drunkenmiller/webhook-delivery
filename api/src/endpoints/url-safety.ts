import { BlockList, isIP } from 'node:net';

// SSRF (Server-Side Request Forgery) guard for endpoint URLs (SPEC §10).
//
// The worker POSTs to whatever URL a customer registers. Without a check, a customer could register
// http://169.254.169.254/… (the cloud metadata service, which hands out credentials) or
// http://10.0.0.5:5432 and make OUR servers talk to OUR private network.
//
// This check runs when an endpoint is created or updated, on the URL as written. It catches literal
// IPs and localhost names. It cannot catch a public hostname whose DNS later resolves to a private
// address (DNS rebinding): that needs a second check when the worker actually connects.

const blocked = new BlockList();

// IPv4 ranges that are not the public internet.
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private (RFC 1918)
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, includes cloud metadata 169.254.169.254
  ['172.16.0.0', 12], // private (RFC 1918)
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // private (RFC 1918)
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes broadcast 255.255.255.255
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}

// IPv6 equivalents. IPv4-mapped addresses (::ffff:127.0.0.1) are matched against the IPv4 rules
// above by BlockList itself.
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['fc00::', 7], // unique local (the IPv6 "private" range)
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

// True when the URL points at a loopback, private, link-local or otherwise non-public destination.
export function isPrivateTarget(url: URL): boolean {
  // The WHATWG URL parser has already normalized the host: lowercased it and turned tricks like
  // http://2130706433/ or http://0x7f.1/ into 127.0.0.1. IPv6 hosts keep their brackets: [::1].
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true; // RFC 6761: *.localhost always resolves to loopback
  }

  const family = isIP(host); // 4, 6, or 0 for a hostname
  if (family === 0) {
    return false; // a name: resolved later, see the note on DNS rebinding above
  }
  return blocked.check(host, family === 4 ? 'ipv4' : 'ipv6');
}
