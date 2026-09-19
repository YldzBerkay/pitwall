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
 *
 * Known consequence of the /16 design (not a defect): a well-known address
 * can map to a region other than its own country's, because a /16 block is
 * assigned to whichever region owns the most addresses within it. Example:
 * 1.1.1.1 returns SEA, not OCE, because 1.1.0.0/16 is split between AU
 * (256 addresses), CN+JP (32,512), and TH (32,768) — TH's region wins the
 * majority vote.
 *
 * This is a convenience-only lookup: if the table can't be read (missing
 * file, bad checkout, build step that dropped non-source assets), we must
 * not take the whole server down over an onboarding hint. Failure to load
 * degrades to an all-zero table (every lookup returns null, the documented
 * "unclassified" result) rather than throwing at module load.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { REGIONS, type Region } from './region.ts';

const TABLE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ip-region-v4.bin');
const TABLE_SIZE = 65536;

/**
 * Loads the lookup table from `tablePath`, falling back to an all-zero
 * buffer (every address unclassified) if the file is missing or unreadable.
 * Logs once via console.error on failure — never logs any IP address, only
 * the table path and the underlying error message.
 */
export function loadTable(tablePath: string): Buffer {
  try {
    return readFileSync(tablePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[ipRegion] could not read region table at ${tablePath} (${message}); ` +
        'region suggestions are disabled.',
    );
    return Buffer.alloc(TABLE_SIZE);
  }
}

const TABLE: Buffer = loadTable(TABLE_PATH);

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
