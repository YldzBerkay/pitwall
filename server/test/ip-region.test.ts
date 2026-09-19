import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { regionForIp, loadTable } from '../src/identity/ipRegion.ts';
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

describe('loadTable', () => {
  it('returns the real table unchanged when the file is present', () => {
    const realPath = new URL('../src/identity/ip-region-v4.bin', import.meta.url).pathname;
    const table = loadTable(realPath);
    assert.equal(table.length, 65536);
  });

  it('degrades to an all-zero 65536-byte buffer when the file is missing, instead of throwing', () => {
    const missingPath = new URL('../src/identity/does-not-exist.bin', import.meta.url).pathname;
    const originalError = console.error;
    let calls: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      calls.push(args);
    };
    let table: Buffer;
    try {
      assert.doesNotThrow(() => {
        table = loadTable(missingPath);
      });
    } finally {
      console.error = originalError;
    }

    table = table!;
    assert.equal(table.length, 65536);
    assert.ok(table.every((byte) => byte === 0), 'expected an all-zero fallback buffer');

    // Exactly one console.error call for the failed load.
    assert.equal(calls.length, 1);
    const logged = calls[0]!.join(' ');
    // No IP address may ever reach a log line — only the path and the error message.
    assert.doesNotMatch(logged, /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
    assert.match(logged, /could not read region table/);
    assert.match(logged, /does-not-exist\.bin/);
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
