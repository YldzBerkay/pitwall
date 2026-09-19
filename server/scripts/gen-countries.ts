/**
 * Generates src/identity/countries.ts from CLDR data.
 *
 * Run with `npm run gen:countries`. Never edit the generated file by hand —
 * fix the mapping logic here instead and regenerate.
 *
 * Why generate instead of hand-writing the list: country names must be
 * ENDONYMS (each territory named in its own primary official language,
 * never localised into the app's UI language — a Japanese player always
 * sees 日本, regardless of which language build of the app they run). CLDR
 * is the canonical source for both territory containment (continents/regions)
 * and per-locale territory display names, so we derive the whole table from
 * it at build time rather than trusting a hand-maintained list to stay
 * endonymic and complete.
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);

const territoryInfo: Record<
  string,
  {
    languagePopulation?: Record<
      string,
      { _populationPercent?: string; _officialStatus?: string }
    >;
  }
> = require('cldr-core/supplemental/territoryInfo.json').supplemental.territoryInfo;

const territoryContainment: Record<
  string,
  { _contains?: string[] } | { group?: { _contains?: string[] } }
> = require('cldr-core/supplemental/territoryContainment.json').supplemental.territoryContainment;

function containsOf(code: string): string[] {
  const entry = territoryContainment[code] as
    | { _contains?: string[]; group?: { _contains?: string[] } }
    | undefined;
  if (!entry) return [];
  return entry._contains ?? entry.group?._contains ?? [];
}

/**
 * Recursively resolve a territory-containment node down to its two-letter
 * ISO 3166-1 alpha-2 leaves. UN M49 group codes (numeric, or codes like
 * 'QO') contain further subgroups rather than countries directly, so we
 * must walk all the way down.
 */
function resolveLeaves(code: string, seen = new Set<string>()): string[] {
  if (seen.has(code)) return [];
  seen.add(code);
  const children = containsOf(code);
  if (children.length === 0) {
    // Leaf. Only keep genuine two-letter alpha codes (drops any stray
    // numeric/group codes that have no further containment listed).
    return /^[A-Z]{2}$/.test(code) ? [code] : [];
  }
  return children.flatMap((child) => resolveLeaves(child, seen));
}

// All real territories, reached by walking down from the World node ('001').
// This is also what quietly drops CLDR's 'ZZ' (Unknown Region): it is not
// contained anywhere under '001', so it never appears in this set.
const allLeafCodes = new Set(resolveLeaves('001'));

// ---------------------------------------------------------------------------
// Region mapping (precedence order — see spec).
// ---------------------------------------------------------------------------

const MENA = new Set(
  'DZ BH EG IR IQ IL JO KW LB LY MA OM PS QA SA SY TN TR AE YE EH SD MR'.split(' '),
);
const SEA = new Set('BN KH ID LA MY MM PH SG TH TL VN'.split(' '));
const NA_LEAVES = new Set(resolveLeaves('021'));
const LATAM_LEAVES = new Set(resolveLeaves('419'));
const OCE_LEAVES = new Set(resolveLeaves('009'));
const APAC_LEAVES = new Set(resolveLeaves('142'));

type Region = 'EU' | 'NA' | 'LATAM' | 'MENA' | 'APAC' | 'SEA' | 'OCE';

/**
 * Sub-Saharan Africa has no bucket of its own: it is a deliberate product
 * decision (not an oversight) to fold it into EU, since sub-Saharan Africa's
 * timezones (roughly UTC+0..+3) are the closest match to Europe's — a player
 * there gets the same race-hour bucket as a European player rather than a
 * time-zone-mismatched bucket like APAC or NA.
 */
function regionFor(code: string): Region {
  if (MENA.has(code)) return 'MENA';
  if (SEA.has(code)) return 'SEA';
  if (NA_LEAVES.has(code)) return 'NA';
  if (LATAM_LEAVES.has(code)) return 'LATAM';
  if (OCE_LEAVES.has(code)) return 'OCE';
  if (APAC_LEAVES.has(code)) return 'APAC';
  return 'EU';
}

// ---------------------------------------------------------------------------
// Endonym resolution.
// ---------------------------------------------------------------------------

/**
 * Explicit locale overrides, keyed by territory code, for cases where the
 * generic "largest official-language population" rule picks a locale whose
 * CLDR territories.json doesn't carry the expected endonym (or carries a
 * different one than the territory's own usage). Value is the CLDR locale
 * id to use for the lookup instead of the auto-picked one.
 */
const LOCALE_OVERRIDE: Record<string, string> = {};

/**
 * Territory's official (or de-facto-official) languages, ordered from most
 * to least populous. Used to walk down the list when the top-ranked
 * language turns out to have no CLDR territories.json to resolve an
 * endonym from — rather than falling straight through to English.
 */
function officialLanguagesFor(code: string): string[] {
  const langs = territoryInfo[code]?.languagePopulation;
  if (!langs) return [];
  return Object.entries(langs)
    .filter(([, info]) => {
      const status = info._officialStatus;
      return status === 'official' || status === 'de_facto_official';
    })
    .sort(
      ([, a], [, b]) =>
        parseFloat(b._populationPercent ?? '0') - parseFloat(a._populationPercent ?? '0'),
    )
    .map(([lang]) => lang);
}

/** Convert a CLDR language tag (underscores) to a locale directory name (hyphens). */
function toLocaleDirName(tag: string): string {
  return tag.replace(/_/g, '-');
}

function loadTerritoriesJson(localeDir: string): Record<string, string> | undefined {
  try {
    const mod = require(`cldr-localenames-full/main/${localeDir}/territories.json`);
    const mainKey = Object.keys(mod.main)[0];
    return mod.main[mainKey]?.localeDisplayNames?.territories;
  } catch {
    return undefined;
  }
}

/**
 * Walk a locale tag down from most to least specific
 * ("zh_Hant_TW" -> "zh-Hant-TW" -> "zh-Hant" -> "zh"), returning the
 * territory-name table for the first one that resolves and contains an
 * entry for `code`.
 */
function resolveEndonym(code: string, langTag: string): string | undefined {
  const parts = toLocaleDirName(langTag).split('-');
  for (let i = parts.length; i > 0; i--) {
    const dir = parts.slice(0, i).join('-');
    const territories = loadTerritoriesJson(dir);
    const name = territories?.[code];
    if (name) return name;
  }
  return undefined;
}

const englishTerritories = loadTerritoriesJson('en')!;

interface Country {
  readonly code: string;
  readonly name: string;
  readonly region: Region;
}

const fallbacks: string[] = [];
const countries: Country[] = [];

for (const code of Array.from(allLeafCodes).sort()) {
  const overrideLocale = LOCALE_OVERRIDE[code];
  const langTags = overrideLocale ? [overrideLocale] : officialLanguagesFor(code);

  let name: string | undefined;
  for (const langTag of langTags) {
    name = resolveEndonym(code, langTag);
    if (name) break;
  }
  if (!name) {
    name = englishTerritories[code];
    fallbacks.push(code);
  }
  if (!name) {
    // No English name either (shouldn't happen for a real territory) — skip it.
    continue;
  }

  countries.push({ code, name, region: regionFor(code) });
}

countries.sort((a, b) => a.code.localeCompare(b.code));

// ---------------------------------------------------------------------------
// Emit.
// ---------------------------------------------------------------------------

const header = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Regenerate with \`npm run gen:countries\` (see scripts/gen-countries.ts).
 * Country names are endonyms sourced from CLDR territory data, resolved to
 * each territory's most-populous official/de-facto-official language and
 * NEVER localised into the app's own UI language.
 */
import type { Region } from './region.ts';

export interface Country {
  readonly code: string;
  readonly name: string;
  readonly region: Region;
}

export const COUNTRIES: readonly Country[] = [
${countries.map((c) => `  { code: ${JSON.stringify(c.code)}, name: ${JSON.stringify(c.name)}, region: ${JSON.stringify(c.region)} },`).join('\n')}
];

const BY_CODE: ReadonlyMap<string, Country> = new Map(COUNTRIES.map((c) => [c.code, c]));

export function countryByCode(code: string): Country | undefined {
  return BY_CODE.get(code);
}

export function isCountryCode(code: unknown): code is string {
  return typeof code === 'string' && BY_CODE.has(code);
}
`;

const outPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'identity',
  'countries.ts',
);
writeFileSync(outPath, header, 'utf8');

console.log(`Wrote ${countries.length} countries to ${path.relative(process.cwd(), outPath)}`);
if (fallbacks.length > 0) {
  console.log(`Fell back to English name for ${fallbacks.length} territories: ${fallbacks.join(', ')}`);
} else {
  console.log('No territory fell back to English.');
}
