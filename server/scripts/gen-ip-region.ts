/**
 * Generates src/identity/ip-region-v4.bin from the five RIR delegation
 * files.
 *
 * Run with `npm run gen:ip-region`. Never edit the generated .bin by hand —
 * fix the mapping logic here instead and regenerate. Needs network access;
 * not run at server boot or in CI — this is an offline, build-time step, and
 * the resulting 64KB table is committed to the repo.
 *
 * PRIVACY CONTRACT: this script processes public RIR delegation records
 * (registry|country|type|start|count|...), not user data. Nothing here
 * touches a real user's IP address.
 *
 * Table format: a flat 65536-byte array indexed by `(a << 8) | b` for an
 * address a.b.c.d. Value 0 = unclassified; value n>0 = REGIONS[n - 1].
 *
 * Resolution strategy: a delegation record covers a contiguous IPv4 range
 * that may span many /16 blocks, or only part of one. For every /16 block
 * touched by any record, we tally how many individual addresses within that
 * block are claimed by each region (via the record's country -> region
 * mapping), and assign the block to whichever region holds the most
 * addresses in it. Ties break alphabetically by region code, so the result
 * is deterministic.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { REGIONS, type Region } from '../src/identity/region.ts';
import { countryByCode } from '../src/identity/countries.ts';

const OUT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'identity',
  'ip-region-v4.bin',
);

const SOURCES = [
  'https://ftp.ripe.net/pub/stats/ripencc/delegated-ripencc-extended-latest',
  'https://ftp.arin.net/pub/stats/arin/delegated-arin-extended-latest',
  'https://ftp.apnic.net/stats/apnic/delegated-apnic-extended-latest',
  'https://ftp.lacnic.net/pub/stats/lacnic/delegated-lacnic-extended-latest',
  'https://ftp.afrinic.net/pub/stats/afrinic/delegated-afrinic-extended-latest',
];

function ipToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const v = Number(part);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

interface Record_ {
  startInt: number;
  count: number;
  region: Region;
}

async function fetchLines(url: string): Promise<string[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const text = await res.text();
  return text.split('\n');
}

async function main() {
  const records: Record_[] = [];
  let totalLines = 0;

  for (const url of SOURCES) {
    const lines = await fetchLines(url);
    for (const line of lines) {
      if (!line || line.startsWith('#') || line.startsWith('2')) continue; // header/version lines
      const fields = line.split('|');
      if (fields.length < 7) continue;
      const [, cc, type, start, countStr, , status] = fields;
      if (type !== 'ipv4') continue;
      if (status !== 'allocated' && status !== 'assigned') continue;
      totalLines++;
      const startInt = ipToInt(start!);
      const count = Number(countStr);
      if (startInt === null || !Number.isFinite(count) || count <= 0) continue;
      const country = countryByCode(cc!);
      if (!country) continue;
      records.push({ startInt, count, region: country.region });
    }
  }

  // tally[block] = Map<Region, addressCount>
  const tally: Map<Region, number>[] = new Array(65536);

  for (const rec of records) {
    const endInt = rec.startInt + rec.count - 1;
    const blockStart = rec.startInt >>> 16;
    const blockEnd = Math.min(endInt, 0xffffffff) >>> 16;
    for (let block = blockStart; block <= blockEnd && block < 65536; block++) {
      const blockLo = block * 65536;
      const blockHi = blockLo + 65535;
      const overlapStart = Math.max(rec.startInt, blockLo);
      const overlapEnd = Math.min(endInt, blockHi);
      if (overlapEnd < overlapStart) continue;
      const addresses = overlapEnd - overlapStart + 1;
      let m = tally[block];
      if (!m) {
        m = new Map();
        tally[block] = m;
      }
      m.set(rec.region, (m.get(rec.region) ?? 0) + addresses);
    }
  }

  const table = new Uint8Array(65536); // all zero = unclassified
  let classifiedCount = 0;
  let conflictCount = 0;

  for (let block = 0; block < 65536; block++) {
    const m = tally[block];
    if (!m || m.size === 0) continue;
    if (m.size > 1) conflictCount++;

    let bestRegion: Region | null = null;
    let bestCount = -1;
    for (const region of [...m.keys()].sort()) {
      const c = m.get(region)!;
      if (c > bestCount) {
        bestCount = c;
        bestRegion = region;
      }
    }
    if (bestRegion) {
      table[block] = REGIONS.indexOf(bestRegion) + 1;
      classifiedCount++;
    }
  }

  writeFileSync(OUT_PATH, Buffer.from(table));

  const coveragePct = ((classifiedCount / 65536) * 100).toFixed(2);
  console.log(`Parsed ${records.length} usable ipv4 records (of ${totalLines} allocated/assigned ipv4 lines).`);
  console.log(`Classified ${classifiedCount} / 65536 /16 blocks (${coveragePct}%).`);
  console.log(`${conflictCount} /16 blocks had more than one region claiming addresses (resolved by majority).`);
  console.log(`Wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
