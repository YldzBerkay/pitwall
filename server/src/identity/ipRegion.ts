/**
 * Offline IPv4 → region lookup.
 *
 * PRIVACY CONTRACT: this module never stores, logs, or returns the address
 * it is given. `regionForIp` takes an IP string, turns it into a bucket, and
 * returns only the bucket. No third party is contacted at runtime — the
 * lookup table (`ip-region-v4.bin`) is generated at build time from public
 * RIR delegation files (see scripts/gen-ip-region.ts) and shipped in the repo.
 *
 * The table is /16 resolution: a flat 65536-byte array indexed by the first
 * two octets of the address, value = region index into REGIONS (0 = unknown
 * / unclassified). Continent-level accuracy is all a *suggestion* needs.
 *
 * IPv6 is unsupported on purpose — no v6 table is shipped — so any IPv6
 * input returns null and the client simply shows no pre-selected region.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { REGIONS, type Region } from './region.ts';

const TABLE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ip-region-v4.bin');
const TABLE: Buffer = readFileSync(TABLE_PATH);

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Returns the suggested region for a dotted-quad IPv4 address, or null when
 * the input is not a usable public IPv4 address (malformed, IPv6, or a
 * reserved/private/loopback/CGNAT/multicast range).
 */
export function regionForIp(ip: string): Region | null {
  const match = IPV4_PATTERN.exec(ip.trim());
  if (!match) return null;

  const octets = [match[1]!, match[2]!, match[3]!, match[4]!].map((part) => Number(part));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;

  const [a, b] = octets as [number, number, number, number];

  if (a === 0) return null; // "this network"
  if (a === 10) return null; // RFC1918 private
  if (a === 127) return null; // loopback
  if (a === 100 && b >= 64 && b <= 127) return null; // CGNAT (RFC6598)
  if (a === 169 && b === 254) return null; // link-local
  if (a === 172 && b >= 16 && b <= 31) return null; // RFC1918 private
  if (a === 192 && b === 168) return null; // RFC1918 private
  if (a >= 224) return null; // multicast/reserved

  const index = TABLE[(a << 8) | b];
  if (!index) return null; // 0 = unclassified

  return REGIONS[index - 1] ?? null;
}
