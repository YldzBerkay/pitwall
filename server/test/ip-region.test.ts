import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { regionForIp } from '../src/identity/ipRegion.ts';
import { clientIpOf } from '../src/http/clientIp.ts';
import { isRegion } from '../src/identity/region.ts';

describe('regionForIp', () => {
  it('returns null for unusable input', () => {
    assert.equal(regionForIp(''), null);
    assert.equal(regionForIp('not-an-ip'), null);
    assert.equal(regionForIp('999.1.1.1'), null);
  });

  it('returns null for IPv6 — we ship no v6 table', () => {
    assert.equal(regionForIp('2a01:4f8:c17:b8f::1'), null);
  });

  it('returns null for private and loopback ranges', () => {
    assert.equal(regionForIp('127.0.0.1'), null);
    assert.equal(regionForIp('10.0.0.1'), null);
    assert.equal(regionForIp('192.168.1.1'), null);
    assert.equal(regionForIp('172.16.0.1'), null);
  });

  it('maps well-known public addresses to a valid bucket', () => {
    const google = regionForIp('8.8.8.8');
    assert.equal(google, 'NA');
    const tt = regionForIp('88.255.0.1');
    assert.ok(tt !== null && isRegion(tt), `expected a bucket, got ${tt}`);
  });

  it('is consistent across a /16 boundary', () => {
    assert.equal(regionForIp('8.8.0.1'), regionForIp('8.8.255.254'));
  });
});

describe('clientIpOf', () => {
  it('reads the leftmost entry of x-forwarded-for', () => {
    assert.equal(
      clientIpOf({ 'x-forwarded-for': '203.0.113.9, 70.41.3.18, 150.172.238.178' }, '10.0.0.5'),
      '203.0.113.9',
    );
  });

  it('falls back to the socket address when the header is absent', () => {
    assert.equal(clientIpOf({}, '203.0.113.9'), '203.0.113.9');
  });

  it('strips an IPv4-mapped IPv6 prefix', () => {
    assert.equal(clientIpOf({}, '::ffff:203.0.113.9'), '203.0.113.9');
  });

  it('returns an empty string when there is nothing to read', () => {
    assert.equal(clientIpOf({}, undefined), '');
  });
});
