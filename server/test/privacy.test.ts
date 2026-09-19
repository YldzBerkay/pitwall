/**
 * Audits the SOURCE TREE (not just runtime behaviour) for the KVKK/GDPR
 * privacy contract that the rest of the codebase only documents in
 * comments:
 *
 *   - the client IP is read, turned into a region bucket, and dropped —
 *     never stored, logged, or returned;
 *   - raw email addresses and plaintext passwords are never stored — only
 *     `email_hash` / `password_hash`.
 *
 * These are static/structural checks so that a future change which breaks
 * the contract fails CI, rather than shipping quietly. Each assertion below
 * was proven to actually fail against a deliberately-introduced violation
 * before being committed (see the task notes) — a check that can't fail is
 * worse than no check at all.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.join(HERE, '..');
const SRC_ROOT = path.join(SERVER_ROOT, 'src');
const MIGRATIONS_DIR = path.join(SRC_ROOT, 'db', 'migrations');

/** Recursively lists every `.ts` file under `dir`, as absolute paths. */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function relSrc(file: string): string {
  return path.relative(SRC_ROOT, file);
}

const SRC_FILES = listTsFiles(SRC_ROOT);

describe('privacy contract: client IP never reaches a log', () => {
  it('no source file both logs and mentions a client-address source on the same line', () => {
    // A line is suspicious when it BOTH calls console.* AND mentions one of
    // the three ways a client address enters the process: the helper that
    // extracts it (`clientIpOf`), the raw socket field it reads
    // (`remoteAddress`), or the raw header it reads (`x-forwarded-for`).
    // Same-line is deliberately strict — logging the *result* of clientIpOf
    // one line down would still be a violation, but this check exists to
    // catch the common, blunt mistake (`console.log('ip:', someIp)`) at
    // zero false-positive cost. It runs over every .ts file, not just the
    // ones we expect to be innocent.
    const consolePattern = /console\.\w+\s*\(/;
    const addressPattern = /clientIpOf|remoteAddress|x-forwarded-for/i;

    const offenders: string[] = [];
    for (const file of SRC_FILES) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        if (consolePattern.test(line) && addressPattern.test(line)) {
          offenders.push(`${relSrc(file)}:${idx + 1}`);
        }
      });
    }

    assert.deepEqual(offenders, [], `client address reached a log call at: ${offenders.join(', ')}`);
  });
});

describe('privacy contract: schema cannot hold a raw address or raw email', () => {
  const migrationFiles = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => path.join(MIGRATIONS_DIR, f));

  // Sanity check on the test itself: if this is empty, the two checks below
  // would vacuously pass, which is exactly the "can't fail" trap we must
  // avoid.
  it('found at least one migration file to audit', () => {
    assert.ok(migrationFiles.length > 0, 'expected at least one .sql migration under src/db/migrations');
  });

  it('declares no column that could hold a raw client address', () => {
    const ipColumnPattern = /\b(ip_address|last_ip)\b/i;
    const offenders: string[] = [];
    for (const file of migrationFiles) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        if (ipColumnPattern.test(line)) offenders.push(`${path.basename(file)}:${idx + 1}`);
      });
    }
    assert.deepEqual(offenders, [], `found an address-shaped column at: ${offenders.join(', ')}`);
  });

  it('declares no bare "email" column — only "email_hash"', () => {
    // Matches a column declaration like `email text` / `email  varchar(...)`
    // but NOT `email_hash text`, because after "email" there must be
    // whitespace directly followed by a type keyword — "email_hash" has an
    // underscore there instead, so it never matches.
    const bareEmailColumnPattern = /\bemail\s+(text|varchar|char)\b/i;
    const offenders: string[] = [];
    for (const file of migrationFiles) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        if (bareEmailColumnPattern.test(line)) offenders.push(`${path.basename(file)}:${idx + 1}`);
      });
    }
    assert.deepEqual(offenders, [], `found a bare raw-email column at: ${offenders.join(', ')}`);
  });
});

describe('privacy contract: clientIpOf() result is only ever consumed by regionForIp()', () => {
  it('every importer of clientIpOf also references regionForIp', () => {
    const importPattern = /\bclientIpOf\b/;
    const regionPattern = /\bregionForIp\b/;

    const importers = SRC_FILES.filter((file) => {
      if (path.basename(file) === 'clientIp.ts') return false; // defines it, doesn't import it
      const content = readFileSync(file, 'utf8');
      // Must actually import it, not merely mention the name in a comment.
      const importsIt = /import\s*\{[^}]*\bclientIpOf\b[^}]*\}\s*from/.test(content);
      return importsIt;
    });

    assert.ok(importers.length > 0, 'expected at least one file to import clientIpOf (sanity check)');

    const offenders = importers.filter((file) => !regionPattern.test(readFileSync(file, 'utf8')));
    assert.deepEqual(
      offenders.map(relSrc),
      [],
      `file imports clientIpOf without also referencing regionForIp: ${offenders.map(relSrc).join(', ')}`,
    );
  });
});

describe('privacy contract: no source file logs a password or a raw email', () => {
  it('no console.* line mentions password/plaintext/email as a standalone token', () => {
    // Line-drawing: `\b...\b` word-boundary matching. In JS regex, "_" and
    // letters/digits are all "word" characters, so there is NO boundary
    // between "password" and "_hash" in "password_hash", nor between
    // "email" and "Hash" in "emailHash" (camelCase) — the character right
    // after the word is still a word character, so \b does not match there.
    // This means `\bpassword\b` and `\bemail\b` match the bare identifiers
    // (a variable literally named `password`, or the word "email" used on
    // its own) but silently skip `password_hash`, `passwordHash`,
    // `email_hash`, and `emailHash` — exactly the hash-only fields the
    // schema is allowed to carry.
    const consolePattern = /console\.\w+\s*\(/;
    const sensitivePattern = /\b(password|plaintext|email)\b/i;

    const offenders: string[] = [];
    for (const file of SRC_FILES) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        if (consolePattern.test(line) && sensitivePattern.test(line)) {
          offenders.push(`${relSrc(file)}:${idx + 1}`);
        }
      });
    }

    assert.deepEqual(offenders, [], `a log call mentions a password/plaintext/email token at: ${offenders.join(', ')}`);
  });
});

describe('privacy contract: the public profile shape carries no email', () => {
  it('publicProfile() never returns an email key or an email value', async () => {
    const { publicProfile } = await import('../src/identity/routes.ts');

    const TEST_EMAIL = 'driver@example.com';
    // Deliberately over-fill the input with every declared User field PLUS
    // an extra `email` field the User type does not declare. If
    // publicProfile were ever rewritten to spread its input (`{ ...user }`)
    // instead of building an explicit allowlisted object, this extra field
    // would leak straight through and this test would catch it.
    const fakeUser = {
      id: 'user-1',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      gold: 100,
      rankPoints: 50,
      countryCode: 'TR',
      region: 'EU',
      nicknameBase: 'Rakip',
      nicknameTag: '1234',
      email: TEST_EMAIL,
      emailHash: 'sha256:deadbeef',
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = publicProfile(fakeUser as any) as Record<string, unknown>;

    const emailKeys = Object.keys(result).filter((key) => /email/i.test(key));
    assert.deepEqual(emailKeys, [], `publicProfile() result carries an email-shaped key: ${emailKeys.join(', ')}`);

    const emailValues = Object.values(result).filter((value) => value === TEST_EMAIL);
    assert.deepEqual(emailValues, [], 'publicProfile() result carries the raw email as a value');
  });
});
