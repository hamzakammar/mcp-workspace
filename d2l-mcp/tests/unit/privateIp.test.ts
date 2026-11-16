/** G6b: courseWebsite fetcher — reserved IPv4 ranges, NAT64 and IPv4-mapped IPv6. */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/utils/supabase.js', () => ({ supabase: { from: () => ({}) } }));

import { isPrivateIp } from '../../src/study/src/courseWebsite/fetcher.js';

describe('isPrivateIp — reserved IPv4', () => {
  it.each([
    '198.18.0.1', '198.19.255.254',  // benchmarking 198.18.0.0/15
    '192.0.0.8',                     // 192.0.0.0/24
    '100.64.0.1', '100.127.255.255', // CGNAT
    '192.0.2.1', '198.51.100.7', '203.0.113.9',
  ])('blocks %s', (ip) => expect(isPrivateIp(ip)).toBe(true));

  it.each(['198.17.255.255', '198.20.0.1', '192.0.1.1', '100.63.255.255', '100.128.0.1', '8.8.8.8', '142.150.1.1'])(
    'allows public %s', (ip) => expect(isPrivateIp(ip)).toBe(false));
});

describe('isPrivateIp — IPv6', () => {
  it.each([
    '::', '::1', '0:0:0:0:0:0:0:1',
    'fe80::1', 'febf::1', 'fd12::1', 'fc00::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a00:1', '::ffff:169.254.169.254',
    '::ffff:0:192.168.0.1',
    '::127.0.0.1',
    '64:ff9b::10.0.0.1', '64:ff9b::a9fe:a9fe', '64:ff9b::7f00:1',
    '64:ff9b:1::8.8.8.8',
    '2002:0a00:0001::1',
    '2001:db8::1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001::1', // Teredo
  ])('blocks %s', (ip) => expect(isPrivateIp(ip)).toBe(true));

  it.each([
    '2607:f8b0:4004:800::200e',
    '::ffff:8.8.8.8', '::ffff:808:808',
    '64:ff9b::8.8.8.8',
    '2002:0808:0808::1',
  ])('allows public %s', (ip) => expect(isPrivateIp(ip)).toBe(false));

  it('treats non-IP strings as unsafe', () => {
    expect(isPrivateIp('example.com')).toBe(true);
  });
});

describe('fetchPage — bracketed IPv6 literal hosts', () => {
  it('blocks an IPv4-mapped loopback host without DNS', async () => {
    const { fetchPage } = await import('../../src/study/src/courseWebsite/fetcher.js');
    const lookupFn = vi.fn(async () => [{ address: '8.8.8.8' }]);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const url = 'https://[::ffff:127.0.0.1]/x';
    const r = await fetchPage(url, { allowedOrigins: [new URL(url).origin], allowPatterns: [/.*/], lookupFn, maxRetries: 0 } as any);
    expect(r.outcome).not.toBe('ok');
    expect(String(r.error)).toMatch(/private-ip/);
    expect(lookupFn).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
