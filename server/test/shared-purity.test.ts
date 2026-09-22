import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SHARED = fileURLToPath(new URL('../../shared/src/', import.meta.url));

/**
 * `shared/` iki tarafın AYNI sonucu üretmesine dayanıyor. Bir dosya saati ya
 * da tohumsuz rastgeleliği okursa bu garanti sessizce kaybolur: sunucu bir
 * sonuç, istemci başka bir sonuç hesaplar ve kimse fark etmez.
 */
describe('shared purity', () => {
  it('reads neither the clock nor unseeded randomness', async () => {
    const offenders: string[] = [];
    for (const name of (await readdir(SHARED)).filter((f) => f.endsWith('.ts'))) {
      const text = await readFile(join(SHARED, name), 'utf8');
      for (const [i, line] of text.split('\n').entries()) {
        if (/\bDate\.now\(\)|new Date\(\)/.test(line)) offenders.push(`${name}:${i + 1} clock`);
        if (/\bMath\.random\(\)/.test(line)) offenders.push(`${name}:${i + 1} random`);
      }
    }
    assert.deepEqual(offenders, [], `shared/ is not pure: ${offenders.join(', ')}`);
  });

  it('imports nothing from node or from the app trees', async () => {
    const offenders: string[] = [];
    for (const name of (await readdir(SHARED)).filter((f) => f.endsWith('.ts'))) {
      const text = await readFile(join(SHARED, name), 'utf8');
      for (const [i, line] of text.split('\n').entries()) {
        if (/from\s+['"]node:/.test(line)) offenders.push(`${name}:${i + 1} node import`);
        if (/from\s+['"]\.\.\//.test(line)) offenders.push(`${name}:${i + 1} escapes the package`);
      }
    }
    assert.deepEqual(offenders, [], `shared/ reaches outside itself: ${offenders.join(', ')}`);
  });
});
