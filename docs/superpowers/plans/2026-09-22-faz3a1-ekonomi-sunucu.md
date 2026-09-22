# Faz 3a-1 — Ekonomi Durumu ve Zamanlayıcılar (Sunucu) · Uygulama Planı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lobi ekonomisini (RP, Altın, fabrika, zamanlayıcılar) istemciden alıp sunucuya taşımak; cihaz saati hilesini ve doğrudan değer değiştirmeyi yapısal olarak imkânsız kılmak.

**Architecture:** Ekonomi formülleri `mobile/src/data/` içinden repo kökündeki bağımsız bir `shared/` paketine çıkar; `mobile` ve `server` ikisi de oradan okur. Sunucu tarafında ekonomi Postgres'te durur, tek bir eylem ucuyla değişir ve yanıt olarak slotun **tüm** durumunu döner. Zamanlayıcılar claim modeliyle çalışır: `ends_at`'in geçmesi hiçbir şey yazmaz, yalnızca oyuncunun claim'i yazar ve o da idempotenttir.

**Tech Stack:** Node 24 · TypeScript 5.9 · tsx · `node:test` · Postgres 17 (`pg`) · Expo SDK 57 / React Native 0.86 (Metro) · `jose` (mevcut)

**Spec:** [2026-09-22-faz3a-ekonomi-sunucuya-tasarim.md](../specs/2026-09-22-faz3a-ekonomi-sunucuya-tasarim.md) — §3 otorite, §4 shared, §5 claim, §7 altın, §9 takım değeri, §11 veri modeli, §12 sunucu yapısı, §13 doğrulama

---

## Kapsam

**Bu planda var:** `shared/` paketi ve taşıma · `003_economy.sql` · `lobby_economy` ve koltuk atamaya bağlanması · `pending_jobs` claim modeli · eylem ucu ve slot durumu yanıtı · Altın muslukları (AdMob SSV, mağaza makbuzu, günlük tavanlar) · takım değeri · bildirim görevi.

**Bu planda yok:**
- **İstemci tarafı** (spec §14 adım 8) — mobil store'un yeniden bağlanması, salt-okunur önbellek, çevrimdışı şeridi. Ayrı plan; sunucu bitmeden yazmanın anlamı yok.
- **Faz 3a-2** — lobi yarış koşucusu, yarış muhasebesi, parc fermé/pit yolu, eski ligin kaldırılması.

**3a-1'in dürüst sınırı:** bu plan bittiğinde lobi ekonomisi kalıcı ve hileye kapalı olur, ama **kazanç döngüsü kapanmaz** — RP'nin ana kaynağı yarış ödülüdür ve o 3a-2'de bağlanır. 3a-1'de ekonomi başlangıç RP'siyle ve Altın→RP dönüşümüyle beslenir.

---

## Mevcut durum — uygulayıcının bilmesi gerekenler

Bunlar koda bakılarak doğrulandı; varsayım değil.

**`mobile/src/data/` tamamen kendi içine kapalı.** 16 dosyanın hiçbiri `../` ile dışarı çıkmıyor; yalnızca birbirlerini import ediyorlar. Bağımlılık grafiği:

```
rng, tracks, economy, regions, mock        → hiçbir şeye bağlı değil
teams          → rng
factory        → economy
carCustomisation → economy
driverMarket   → rng, teams
staff          → rng
sponsors       → economy, rng
espionage      → rng, driverMarket
raceEngine     → carCustomisation, rng, teams, tracks
achievements   → teams, raceEngine
season         → teams, tracks, achievements
brief          → carCustomisation, raceEngine, rng, tracks
```

**İki bağımsız npm projesi var, kök `package.json` YOK.** `mobile/` ve `server/` ayrı.

**Mobil `@/*` → `./src/*` alias'ı kullanıyor** (`mobile/tsconfig.json`), ve **34 dosya** `@/data/...` import ediyor.

**Sunucu bugün mobil kaynak ağacına uzanıyor:** `server/tsconfig.json`'ın `include`'unda `../mobile/src/data/**/*.ts` var ve şu dosyalar import ediliyor: `teams`, `season`, `raceEngine`, `achievements`, `tracks`.

**`server/src/lobby/lobbyRepo.ts:takeSeat`** zaten tek transaction ve lobi satırı kilitli — `lobby_economy` satırı oraya girecek.

**Postgres:** 17, port 5432, rol `pitwall`/`pitwall`, veritabanları `pitwall` ve `pitwall_test`. `npm test` `--test-concurrency=1` ile koşuyor.

---

## Görev sırası — bir bağımlılık istisnası

Görevler numara sırasıyla koşulur, **tek istisna dışında**: Görev 6 (`economy/jobs.ts`)
`spendGold`'u `gold/repo.ts`'ten import ediyor ve o dosya Görev 8'de doğuyor.

**Görev 8'i Görev 6'dan önce koş.** Alternatif olarak Görev 6'da `gold/repo.ts`'i
yalnızca `spendGold` ile oluşturup gerisini Görev 8'de tamamlayabilirsin, ama o
zaman Görev 8'in testi yarısı yazılmış bir dosyaya bakar — sıra değiştirmek daha
temiz.

Geri kalan sıra doğrudur: 1 → 2 → 3 → 4 → 5 → **8** → 6 → 7 → 9 → 10 → 11 → 12 → 13 → 14 → 15.

## Test yardımcısı: bir lobi kurmak

> **Düzeltme (Görev 3'ten sonra):** Bu planın görevlerindeki `makeLobby()`
> örnekleri `lobbies` tablosunun gerçek şeklini yanlış varsayıyordu. Aşağıdaki
> **doğru** sürümdür; bir lobi satırı gereken her görevde bunu kullan, görev
> metnindeki eski sürümü değil.

`lobbies` üç zorunlu alanı vardır ki plan bunları atlamıştı: `name_base` ve
`name_seq` (`(name_base, name_seq)` üzerinde benzersiz indeks var — aynı çifti
iki kez yazma), ve **`creator_user_id` NOT NULL'dur**, yani önce gerçek bir
kullanıcı satırı gerekir.

```ts
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { query } from '../src/db/pool.ts';

let seq = 0;

/** Testin ihtiyaç duyduğu en küçük lobi. `seq` her çağrıda artar ki
 *  `(name_base, name_seq)` benzersizliği aynı test dosyasında çakışmasın. */
async function makeLobby(label = 'Test'): Promise<string> {
  const owner = await createUserWithIdentity({
    base: 'GridHunter',
    provider: 'google',
    providerUid: `g-${label}-${++seq}`,
    emailHash: null,
  });
  const res = await query<{ id: string }>(
    `insert into lobbies (name, name_base, name_seq, region, visibility, ai_difficulty,
                          rank_min, rank_max, guests_can_invite, mid_season_join,
                          creator_user_id, next_race_at)
     values ($1, $2, $3, 'EU', 'private', 'normal', 1, 10, false, true, $4,
             now() + interval '1 day')
     returning id`,
    [`${label} #${seq}`, label, seq, owner.id],
  );
  return res.rows[0].id;
}
```

`beforeEach`'te `delete from lobbies` **ve** `delete from users` çağır — lobi
kullanıcıya bağlı olduğu için yalnızca birini silmek yabancı anahtar hatası ya
da birikmiş çöp satır bırakır.

## Dosya yapısı

| Dosya | Sorumluluk |
|---|---|
| `shared/package.json` | Bağımsız paket tanımı (`@pitwall/shared`), derleme adımı yok |
| `shared/tsconfig.json` | Paketin kendi tip denetimi |
| `shared/src/*.ts` | `mobile/src/data/`'dan taşınan saf formüller |
| `mobile/metro.config.js` | **Değişir** — `shared/`'ı izlemek için `watchFolders` |
| `mobile/tsconfig.json` | **Değişir** — `@shared/*` yolu |
| `server/tsconfig.json` | **Değişir** — mobil ağacına uzanma kalkar |
| `server/src/db/migrations/003_economy.sql` | `lobby_economy`, `pending_jobs`, `gold_grants`, `daily_caps` |
| `server/src/economy/repo.ts` | `lobby_economy` okuma/yazma |
| `server/src/economy/jobs.ts` | `pending_jobs`: başlat, claim, atla |
| `server/src/economy/value.ts` | Takım değeri (tek hesap yeri) |
| `server/src/economy/state.ts` | Slot durumu yanıtı (`serverNow` dahil) |
| `server/src/economy/actions.ts` | Eylem yönlendirmesi ve doğrulama |
| `server/src/economy/routes.ts` | `POST /lobby/:id/action` |
| `server/src/gold/repo.ts` | `users.gold`, `gold_grants`, `daily_caps` |
| `server/src/gold/ssv.ts` | AdMob sunucu-taraflı doğrulama |
| `server/src/gold/receipts.ts` | Mağaza makbuzu doğrulaması |
| `server/src/gold/routes.ts` | SSV callback ve makbuz uçları |
| `server/src/notify/scheduler.ts` | Biten işleri tarar, bildirir, **ekonomiye dokunmaz** |

---

## Görev 1: `shared/` paketi ve Metro doğrulaması

> **Bu görev planın en riskli parçası ve bilerek en başa konuldu.** Metro (React Native bundler) proje kökü dışındaki dosyaları varsayılan olarak paketlemez. Çalışmazsa bütün planın temeli çöker, o yüzden tek bir dosyayla önce bunu kanıtlıyoruz — 16 dosyayı taşıyıp sonra öğrenmek yerine.

**Files:**
- Create: `shared/package.json`, `shared/tsconfig.json`, `shared/src/probe.ts`
- Modify: `mobile/metro.config.js`, `mobile/tsconfig.json`, `mobile/package.json`, `server/tsconfig.json`, `server/package.json`
- Test: `server/test/shared-wiring.test.ts`

- [ ] **Step 1: `shared/package.json` oluştur**

```json
{
  "name": "@pitwall/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Pit Wall'ın saf oyun formülleri: ekonomi, fabrika, yarış motoru. mobile ve server ikisi de buradan okur.",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./*": "./src/*.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p ."
  },
  "devDependencies": {
    "typescript": "~5.9.0"
  }
}
```

Kaynak TypeScript doğrudan tüketilir, derleme adımı yoktur: Metro zaten transpile ediyor, sunucuda `tsx` aynısını yapıyor. Bir `dist/` adımı eklemek her iki tarafa da senkronizasyon derdi getirirdi.

- [ ] **Step 2: `shared/tsconfig.json` oluştur**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "types": []
  },
  "include": ["src/**/*.ts"]
}
```

`"types": []` kasıtlı: `shared/` saf kalmalı, `node` tiplerine erişimi olmamalı. Bir gün biri oraya `fs` import etmeye kalkarsa tip denetimi durdurur.

- [ ] **Step 3: Sonda dosyasını yaz**

`shared/src/probe.ts`:

```ts
/** Kablolamanın çalıştığını kanıtlayan geçici sonda. Görev 2'de silinir. */
export const SHARED_PROBE = 'shared-package-reachable' as const;
```

`shared/src/index.ts`:

```ts
export { SHARED_PROBE } from './probe.ts';
```

- [ ] **Step 4: Paketleri bağla**

```bash
cd /Users/berkay/Documents/My-Projects/pit-wall/shared && npm install
cd ../mobile && npm install file:../shared --legacy-peer-deps
cd ../server && npm install file:../shared
```

`file:` bağımlılığı `node_modules/@pitwall/shared` altında bir sembolik bağ üretir. React Native 0.76'dan beri Metro sembolik bağları çözebiliyor (bu projede 0.86 var), ama **bunu varsaymıyoruz** — Step 7 ölçüyor.

- [ ] **Step 5: `mobile/metro.config.js`'i değiştir**

Dosyanın tamamını şununla değiştir:

```js
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const projectRoot = __dirname;
const sharedRoot = path.resolve(projectRoot, '../shared');

const config = getDefaultConfig(projectRoot);

// react-native-filament loads the car as a .glb — Metro needs to treat it as
// a binary asset, same as a .png, rather than trying to parse it as source.
config.resolver.assetExts = [...config.resolver.assetExts, 'glb'];

// `@pitwall/shared` proje kökünün DIŞINDA yaşıyor. Metro varsayılan olarak
// yalnızca projectRoot altını izler; watchFolders olmadan paketin dosyaları
// "bulunamadı" hatası verir. nodeModulesPaths ikisini de listeler ki paketin
// kendi bağımlılıkları (yok, ama ileride olursa) da çözülebilsin.
config.watchFolders = [sharedRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(sharedRoot, 'node_modules'),
];
config.resolver.unstable_enableSymlinks = true;

module.exports = withNativeWind(config, { input: './global.css' });
```

- [ ] **Step 6: `mobile/tsconfig.json`'a yol ekle**

`paths` bloğunu şununla değiştir:

```json
    "paths": {
      "@/*": ["./src/*"],
      "@pitwall/shared": ["../shared/src/index.ts"],
      "@pitwall/shared/*": ["../shared/src/*.ts"]
    }
```

- [ ] **Step 7: Metro'nun gerçekten paketlediğini KANITLA**

Bu adım atlanamaz. `mobile/app/(tabs)/index.tsx` dosyasının en üstüne geçici olarak ekle:

```ts
import { SHARED_PROBE } from '@pitwall/shared';
console.log('[probe]', SHARED_PROBE);
```

Sonra bundle'ı üret:

```bash
cd /Users/berkay/Documents/My-Projects/pit-wall/mobile
npx expo export --platform ios 2>&1 | tail -20
grep -rl "shared-package-reachable" dist/ | head -3
```

Expected: `expo export` hatasız biter ve `grep` en az bir bundle dosyası listeler.

**Çıktı boşsa DUR ve raporla.** Metro sembolik bağı çözemiyor demektir; o durumda `file:` yerine `watchFolders` + doğrudan göreli yol (`config.resolver.extraNodeModules`) denenmeli, ama bunu sessizce deneme — kontrolöre bildir, çünkü paketin şekli tüm planı etkiliyor.

Doğrulandıktan sonra geçici import'u ve `console.log`'u `index.tsx`'ten geri al.

- [ ] **Step 8: `server/tsconfig.json`'ı değiştir**

`include` ve `exclude` bloklarını şununla değiştir — mobil ağacına uzanma kalkıyor:

```json
  "include": [
    "src/**/*.ts",
    "test/**/*.ts",
    "scripts/**/*.ts"
  ],
  "exclude": ["node_modules"],
```

`compilerOptions`'a ekle (paket kaynak `.ts` sunduğu için gerekli):

```json
    "paths": {
      "@pitwall/shared": ["../shared/src/index.ts"],
      "@pitwall/shared/*": ["../shared/src/*.ts"]
    },
    "baseUrl": "."
```

- [ ] **Step 9: Sunucu tarafını doğrulayan testi yaz**

`server/test/shared-wiring.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SHARED_PROBE } from '@pitwall/shared';

describe('shared package wiring', () => {
  it('is importable from the server by package name', () => {
    assert.equal(SHARED_PROBE, 'shared-package-reachable');
  });
});
```

- [ ] **Step 10: Sunucu testini ve tip denetimini koş**

```bash
cd /Users/berkay/Documents/My-Projects/pit-wall/server
npm test -- --test-name-pattern="shared package wiring"
npm run typecheck
cd ../shared && npm run typecheck
cd ../mobile && npm run typecheck
```

Expected: test PASS; üç tip denetimi de çıktısız.

`tsx`'in `@pitwall/shared`'ı çözemediği bir durumda (`ERR_MODULE_NOT_FOUND`), sembolik bağın gerçekten kurulduğunu `ls -la server/node_modules/@pitwall/` ile doğrula ve raporla — sessizce göreli yola dönme.

- [ ] **Step 11: Commit**

```bash
cd /Users/berkay/Documents/My-Projects/pit-wall
git add shared mobile/metro.config.js mobile/tsconfig.json mobile/package.json mobile/package-lock.json server/tsconfig.json server/package.json server/package-lock.json server/test/shared-wiring.test.ts
git commit -m "chore: shared paketi iskeleti ve Metro/TS kablolaması"
```

Commit trailer'ı için kendi oturumunun attribution talimatını izle.

---

## Görev 2: Formülleri `shared/`'a taşı

**Files:**
- Move: `mobile/src/data/*.ts` → `shared/src/*.ts` (16 dosya, `mock.ts` hariç — o UI sahte verisi, mobilde kalır)
- Delete: `shared/src/probe.ts`
- Modify: `shared/src/index.ts`, 34 mobil dosyanın import'ları, 5 sunucu dosyasının import'ları
- Test: `server/test/shared-wiring.test.ts` (güncellenir)

- [ ] **Step 1: Dosyaları taşı**

`mock.ts` HARİÇ hepsi taşınır — `mock.ts` ekran geliştirme verisi, formül değil:

```bash
cd /Users/berkay/Documents/My-Projects/pit-wall
git mv mobile/src/data/achievements.ts mobile/src/data/brief.ts mobile/src/data/carCustomisation.ts \
       mobile/src/data/driverMarket.ts mobile/src/data/economy.ts mobile/src/data/espionage.ts \
       mobile/src/data/factory.ts mobile/src/data/regions.ts mobile/src/data/rng.ts \
       mobile/src/data/raceEngine.ts mobile/src/data/season.ts mobile/src/data/sponsors.ts \
       mobile/src/data/staff.ts mobile/src/data/teams.ts mobile/src/data/tracks.ts \
       shared/src/
git rm shared/src/probe.ts
```

Dosyalar birbirini `./x.ts` ile import ediyor ve hepsi aynı dizine gittiği için **iç import'ların hiçbiri değişmez**.

- [ ] **Step 2: `shared/src/index.ts`'i yaz**

```ts
/**
 * Pit Wall'ın saf oyun formülleri.
 *
 * KURAL: bu paket saftır. I/O yok, `Date.now()` yok, `Math.random()` yalnızca
 * açıkça verilen tohumla (`rng.ts`). Zaman ve rastgelelik çağıranın
 * sorumluluğudur — sunucu `now()` ve tohumu verir, test sabit verir. Bu kural
 * olmadan aynı formül iki tarafta farklı sonuç üretir.
 */
export * from './achievements.ts';
export * from './brief.ts';
export * from './carCustomisation.ts';
export * from './driverMarket.ts';
export * from './economy.ts';
export * from './espionage.ts';
export * from './factory.ts';
export * from './raceEngine.ts';
export * from './regions.ts';
export * from './rng.ts';
export * from './season.ts';
export * from './sponsors.ts';
export * from './staff.ts';
export * from './teams.ts';
export * from './tracks.ts';
```

`export *` çakışma üretirse (aynı isim iki dosyada), tip denetimi söyler. Çakışan ismi **yeniden adlandırma** — çakışmayı raporla, çünkü iki dosyada aynı isim zaten bir tasarım sorunudur.

- [ ] **Step 3: Mobil import'larını güncelle**

34 dosya `@/data/x` import ediyor; hepsi `@pitwall/shared/x` olacak. `mock.ts` yerinde kaldığı için `@/data/mock` import'u değişmez:

```bash
cd /Users/berkay/Documents/My-Projects/pit-wall/mobile
grep -rl "@/data/" src app | while read f; do
  perl -pi -e "s{\@/data/(?!mock\b)([a-zA-Z]+)}{\@pitwall/shared/\$1}g" "$f"
done
grep -rn "@/data/" src app | grep -v "@/data/mock"
```

Son komut **hiçbir şey yazdırmamalı**. Yazdırırsa elle düzelt ve neyi kaçırdığını raporla.

- [ ] **Step 4: Sunucu import'larını güncelle**

```bash
cd /Users/berkay/Documents/My-Projects/pit-wall/server
grep -rl "mobile/src/data/" src scripts test | while read f; do
  perl -pi -e "s{['\"](?:\.\./)+mobile/src/data/([a-zA-Z]+)\.ts['\"]}{'\@pitwall/shared/\$1'}g" "$f"
done
grep -rn "mobile/src/data" src scripts test
```

Son komut hiçbir şey yazdırmamalı.

- [ ] **Step 5: Sonda testini gerçek bir içe aktarmaya çevir**

`server/test/shared-wiring.test.ts` dosyasının tamamını şununla değiştir:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ECONOMY_SCALE, GOLD_TO_RP, skipCostGold } from '@pitwall/shared/economy';
import { factoryEffects, DEPARTMENT_MAX_LEVEL } from '@pitwall/shared/factory';
import { teams } from '@pitwall/shared/teams';

describe('shared package wiring', () => {
  it('exposes the economy constants the server prices things with', () => {
    assert.equal(ECONOMY_SCALE, 1.5);
    assert.equal(GOLD_TO_RP, 50);
  });

  it('exposes pure helpers that do not read the clock', () => {
    // Biten iş bedava, 1 dakika kalan iş bir saatlik ücret.
    assert.equal(skipCostGold(0), 0);
    assert.equal(skipCostGold(60_000), 5);
  });

  it('exposes the factory effect table', () => {
    assert.equal(DEPARTMENT_MAX_LEVEL, 5);
    assert.equal(factoryEffects({}).upgradeCostScale, 1);
  });

  it('exposes the grid', () => {
    assert.equal(teams.length, 11);
  });
});
```

- [ ] **Step 6: `shared/` gerçekten saf mı — denetim testi yaz**

`server/test/shared-purity.test.ts`:

```ts
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
        // rng.ts tohumlu üreteci tanımlar; tek izinli Math.random orada değil,
        // hiçbir yerde olmamalı.
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
```

- [ ] **Step 7: Saflık testini koş ve ihlalleri gör**

```bash
cd /Users/berkay/Documents/My-Projects/pit-wall/server
npm test -- --test-name-pattern="shared purity"
```

`economy.ts`'teki `dayKey(d: Date = new Date())` bu testi **düşürecek** — ve bu doğru. O fonksiyon cihazın yerel takvimine bakıyor; sunucuda günlük tavan için kullanılamaz.

Düzeltme: varsayılan argümanı kaldır, çağıran tarihi vermek zorunda kalsın.

`shared/src/economy.ts` içindeki satırı:

```ts
export const dayKey = (d: Date = new Date()): string => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
```

şununla değiştir:

```ts
/**
 * Bir tarihin gün anahtarı. Varsayılanı YOKTUR: "hangi gün" sorusunun cevabı
 * istemcide cihazın takvimi, sunucuda UTC'dir ve ikisini karıştırmak günlük
 * tavanın gün değiştirilerek aşılmasına yol açar. Çağıran hangi saati
 * kastettiğini söylemek zorunda.
 */
export const dayKey = (d: Date): string => `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
```

Bu değişikliğin kırdığı mobil çağrı yerlerini (`economySlice.ts`) `dayKey(new Date())` olacak şekilde düzelt — mobil taraf 3a-1'in sonunda zaten sunucudan okuyacak, ama şimdi derlenmesi gerekiyor.

Başka ihlal çıkarsa **testi gevşetme**, dosyayı düzelt ve ne yaptığını raporla.

- [ ] **Step 8: Her şeyi koş**

```bash
cd /Users/berkay/Documents/My-Projects/pit-wall/shared && npm run typecheck
cd ../server && npm run typecheck && DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test npm test
cd ../mobile && npm run typecheck
```

Expected: üçü de temiz, sunucu testleri hepsi geçiyor.

- [ ] **Step 9: Mobil bundle'ın hâlâ üretildiğini doğrula**

```bash
cd /Users/berkay/Documents/My-Projects/pit-wall/mobile && npx expo export --platform ios 2>&1 | tail -5
```

Expected: hatasız biter. Bu, 34 dosyanın yeni import yolunun Metro'da gerçekten çözüldüğünü kanıtlar — tip denetimi bunu kanıtlamaz.

- [ ] **Step 10: Commit**

```bash
cd /Users/berkay/Documents/My-Projects/pit-wall
git add -u && git add shared server/test
git commit -m "refactor: oyun formüllerini shared/ paketine taşı"
```

Bu görevde `git add -u` kullanmak istisnai olarak doğrudur: taşıma 50+ dosyaya dokunuyor ve hepsi bu commit'e ait. Başka bir ajan eşzamanlı çalışıyorsa önce onun bittiğinden emin ol.

---

## Görev 3: `003_economy.sql` şeması

**Files:**
- Create: `server/src/db/migrations/003_economy.sql`
- Test: `server/test/economy-schema.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

`server/test/economy-schema.test.ts`:

```ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool } from '../src/db/pool.ts';

describe('economy schema', () => {
  before(async () => { await runMigrations(); });
  after(async () => { await closePool(); });

  it('creates the four economy tables', async () => {
    const res = await query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const names = res.rows.map((r) => r.table_name);
    for (const t of ['lobby_economy', 'pending_jobs', 'gold_grants', 'daily_caps']) {
      assert.ok(names.includes(t), `${t} missing`);
    }
  });

  it('refuses a negative rp', async () => {
    await assert.rejects(
      () => query(
        `insert into lobby_economy (lobby_id, team_key, rp)
         values ('00000000-0000-0000-0000-000000000000', 'x', -1)`,
      ),
      /lobby_economy_rp_check|foreign key/,
    );
  });

  it('refuses an unknown job kind', async () => {
    await assert.rejects(
      () => query(
        `insert into pending_jobs (lobby_id, team_key, kind, payload, ends_at)
         values ('00000000-0000-0000-0000-000000000000', 'x', 'teleport', '{}', now())`,
      ),
      /pending_jobs_kind_check|foreign key/,
    );
  });

  it('refuses the same gold grant twice', async () => {
    await query(`delete from gold_grants where external_id = 'dup-test'`);
    const userId = (await query<{ id: string }>(
      `insert into users (nickname_base, nickname_tag) values ('GoldProbe', '9001') returning id`,
    )).rows[0].id;
    await query(
      `insert into gold_grants (user_id, source, external_id, gold) values ($1, 'ad', 'dup-test', 1)`,
      [userId],
    );
    await assert.rejects(
      () => query(
        `insert into gold_grants (user_id, source, external_id, gold) values ($1, 'ad', 'dup-test', 1)`,
        [userId],
      ),
      /duplicate key/,
    );
    await query('delete from users where id = $1', [userId]);
  });

  it('keeps one daily cap row per user per day', async () => {
    const userId = (await query<{ id: string }>(
      `insert into users (nickname_base, nickname_tag) values ('CapProbe', '9002') returning id`,
    )).rows[0].id;
    await query(`insert into daily_caps (user_id, day) values ($1, '2026-01-01')`, [userId]);
    await assert.rejects(
      () => query(`insert into daily_caps (user_id, day) values ($1, '2026-01-01')`, [userId]),
      /duplicate key/,
    );
    await query('delete from users where id = $1', [userId]);
  });
});
```

- [ ] **Step 2: Testi koş, başarısız olduğunu gör**

```bash
cd /Users/berkay/Documents/My-Projects/pit-wall/server
DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test npm test -- --test-name-pattern="economy schema"
```
Expected: FAIL — `lobby_economy missing`

- [ ] **Step 3: `server/src/db/migrations/003_economy.sql` yaz**

```sql
-- 003_economy.sql — lobi ekonomisi, zamanlayıcılar ve Altın muslukları.
-- Spec: docs/superpowers/specs/2026-09-22-faz3a-ekonomi-sunucuya-tasarim.md §11
--
-- Bu göç Faz 3a-1'in kapsamıdır. Yarış muhasebesi (`settle`) ve sezon arşivi
-- (`season_archive`) Faz 3a-2 ve Faz 4'e aittir ve burada kasıtlı olarak
-- YOKTUR.

-- ── Lobi ekonomisi ──────────────────────────────────────────────────────────
-- Bir satır = bir lobideki bir takım. AI koltukları da satır alır: yarış
-- motorunun okuduğu tek araç kaynağı burasıdır, insan olup olmaması fark
-- etmez.
create table if not exists lobby_economy (
  lobby_id        uuid        not null references lobbies(id) on delete cascade,
  team_key        text        not null,
  rp              integer     not null default 0,
  factory_levels  jsonb       not null default '{}'::jsonb,
  car             jsonb       not null,
  spy_state       jsonb       not null default '{}'::jsonb,
  upgrades_done   jsonb       not null default '{}'::jsonb,
  updated_at      timestamptz not null default now(),

  constraint lobby_economy_pk primary key (lobby_id, team_key),
  constraint lobby_economy_rp_check check (rp >= 0)
);

-- ── Zamanlayıcılar (§5) ─────────────────────────────────────────────────────
-- `ends_at`'in geçmesi HİÇBİR ŞEY yazmaz; yalnızca claim yazar ve `claimed_at`
-- onu idempotent kılar. `notified_at` yalnızca bildirim görevinindir ve
-- ekonomiye asla dokunmaz.
create table if not exists pending_jobs (
  id           uuid        primary key default gen_random_uuid(),
  lobby_id     uuid        not null references lobbies(id) on delete cascade,
  team_key     text        not null,
  kind         text        not null,
  payload      jsonb       not null default '{}'::jsonb,
  started_at   timestamptz not null default now(),
  ends_at      timestamptz not null,
  claimed_at   timestamptz,
  notified_at  timestamptz,

  constraint pending_jobs_kind_check check (kind in ('upgrade','training','spy'))
);

-- Bir takımın aynı türden iki açık işi olamaz: tek tezgah, tek parça.
create unique index if not exists pending_jobs_open_idx
  on pending_jobs (lobby_id, team_key, kind)
  where claimed_at is null;

-- Bildirim görevinin taradığı küme.
create index if not exists pending_jobs_notify_idx
  on pending_jobs (ends_at)
  where claimed_at is null and notified_at is null;

-- ── Altın muslukları (§7.1) ─────────────────────────────────────────────────
-- Aynı AdMob callback'i ya da aynı mağaza makbuzu iki kez Altın yazamaz;
-- tekilliği veritabanı garanti eder, uygulama mantığı değil.
create table if not exists gold_grants (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references users(id) on delete cascade,
  source      text        not null,
  external_id text        not null,
  gold        integer     not null,
  granted_at  timestamptz not null default now(),

  constraint gold_grants_source_check check (source in ('ad','iap')),
  constraint gold_grants_gold_check check (gold > 0),
  constraint gold_grants_unique unique (source, external_id)
);

create index if not exists gold_grants_user_idx on gold_grants (user_id);

-- Günlük tavanlar hesap seviyesindedir ve gün SUNUCU gününe (UTC) göredir.
-- İstemcinin cihaz takvimini değiştirerek tavanı sıfırlaması bu yüzden
-- imkânsızdır.
create table if not exists daily_caps (
  user_id        uuid    not null references users(id) on delete cascade,
  day            date    not null,
  ads_watched    integer not null default 0,
  gold_converted integer not null default 0,

  constraint daily_caps_pk primary key (user_id, day),
  constraint daily_caps_ads_check check (ads_watched >= 0),
  constraint daily_caps_conv_check check (gold_converted >= 0)
);
```

- [ ] **Step 4: Testi koş, geçtiğini gör**

```bash
cd /Users/berkay/Documents/My-Projects/pit-wall/server
DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test npm test -- --test-name-pattern="economy schema"
```
Expected: PASS — 5 test

- [ ] **Step 5: Geliştirme veritabanına da uygula**

```bash
DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall npm run migrate
```
Expected: `migrated: 003_economy.sql`

- [ ] **Step 6: Commit**

```bash
cd /Users/berkay/Documents/My-Projects/pit-wall/server
git add src/db/migrations/003_economy.sql test/economy-schema.test.ts
git commit -m "feat(server): lobi ekonomisi, zamanlayıcı ve altın musluğu şeması"
```

---

## Görev 4: `economy/repo.ts` — lobi ekonomisi deposu

**Files:**
- Create: `server/src/economy/repo.ts`
- Test: `server/test/economy-repo.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

`server/test/economy-repo.test.ts`:

```ts
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { seedTeamEconomy, loadTeamEconomy, loadLobbyEconomy, spendRp, addRp, setFactoryLevel } from '../src/economy/repo.ts';

/** Testin ihtiyaç duyduğu en küçük lobi: bir satır, bilinen id. */
async function makeLobby(): Promise<string> {
  const res = await query<{ id: string }>(
    `insert into lobbies (name, region, visibility, ai_difficulty, rank_min, rank_max,
                          guests_can_invite, mid_season_join, creator_user_id, next_race_at)
     values ('Test #1', 'EU', 'private', 'normal', 1, 10, false, true, null, now() + interval '1 day')
     returning id`,
  );
  return res.rows[0].id;
}

describe('economy repo', () => {
  let lobbyId: string;
  before(async () => { await runMigrations(); });
  beforeEach(async () => {
    await query('delete from lobbies');
    lobbyId = await makeLobby();
  });
  after(async () => { await closePool(); });

  it('seeds a team with starting rp and a car', async () => {
    await withTransaction((c) => seedTeamEconomy(c, lobbyId, 'bosphorus'));
    const econ = await loadTeamEconomy(lobbyId, 'bosphorus');
    assert.ok(econ, 'no row written');
    assert.ok(econ.rp > 0, 'starting rp must be positive');
    assert.ok(econ.car.motor > 0 && econ.car.aero > 0 && econ.car.grip > 0);
    assert.deepEqual(econ.factoryLevels, {});
  });

  it('is idempotent — seeding twice leaves one row untouched', async () => {
    await withTransaction((c) => seedTeamEconomy(c, lobbyId, 'bosphorus'));
    await withTransaction((c) => spendRp(c, lobbyId, 'bosphorus', 100));
    const before = await loadTeamEconomy(lobbyId, 'bosphorus');
    await withTransaction((c) => seedTeamEconomy(c, lobbyId, 'bosphorus'));
    const after = await loadTeamEconomy(lobbyId, 'bosphorus');
    assert.equal(after!.rp, before!.rp, 're-seeding overwrote a live economy');
  });

  it('loads every team in a lobby at once', async () => {
    await withTransaction(async (c) => {
      await seedTeamEconomy(c, lobbyId, 'bosphorus');
      await seedTeamEconomy(c, lobbyId, 'meridian');
    });
    const all = await loadLobbyEconomy(lobbyId);
    assert.equal(all.length, 2);
  });

  it('refuses to spend more rp than the team has', async () => {
    await withTransaction((c) => seedTeamEconomy(c, lobbyId, 'bosphorus'));
    const econ = await loadTeamEconomy(lobbyId, 'bosphorus');
    const ok = await withTransaction((c) => spendRp(c, lobbyId, 'bosphorus', econ!.rp + 1));
    assert.equal(ok, false);
    const after = await loadTeamEconomy(lobbyId, 'bosphorus');
    assert.equal(after!.rp, econ!.rp, 'balance moved on a refused spend');
  });

  it('spends and credits rp', async () => {
    await withTransaction((c) => seedTeamEconomy(c, lobbyId, 'bosphorus'));
    const start = (await loadTeamEconomy(lobbyId, 'bosphorus'))!.rp;
    assert.equal(await withTransaction((c) => spendRp(c, lobbyId, 'bosphorus', 100)), true);
    await withTransaction((c) => addRp(c, lobbyId, 'bosphorus', 30));
    assert.equal((await loadTeamEconomy(lobbyId, 'bosphorus'))!.rp, start - 100 + 30);
  });

  it('two concurrent spends cannot both succeed past the balance', async () => {
    await withTransaction((c) => seedTeamEconomy(c, lobbyId, 'bosphorus'));
    const start = (await loadTeamEconomy(lobbyId, 'bosphorus'))!.rp;
    const half = Math.floor(start / 2) + 10;
    const [a, b] = await Promise.all([
      withTransaction((c) => spendRp(c, lobbyId, 'bosphorus', half)),
      withTransaction((c) => spendRp(c, lobbyId, 'bosphorus', half)),
    ]);
    assert.equal([a, b].filter(Boolean).length, 1, 'both spends went through');
    assert.ok((await loadTeamEconomy(lobbyId, 'bosphorus'))!.rp >= 0);
  });

  it('records a factory level', async () => {
    await withTransaction((c) => seedTeamEconomy(c, lobbyId, 'bosphorus'));
    await withTransaction((c) => setFactoryLevel(c, lobbyId, 'bosphorus', 'wind_tunnel', 2));
    assert.equal((await loadTeamEconomy(lobbyId, 'bosphorus'))!.factoryLevels.wind_tunnel, 2);
  });
});
```

- [ ] **Step 2: Testi koş, başarısız olduğunu gör**

Expected: FAIL — `Cannot find module '../src/economy/repo.ts'`

- [ ] **Step 3: `server/src/economy/repo.ts` yaz**

```ts
/**
 * Lobi ekonomisinin deposu. Spec §11.
 *
 * Bir satır = bir lobideki bir takım. AI koltukları da satır alır, çünkü yarış
 * motoru için insan ve AI arasında fark yoktur: ikisi de bir araca sahiptir.
 *
 * RP harcaması bakiyeyi ŞARTLI bir UPDATE ile düşürür (`where rp >= $n`).
 * Önce oku-sonra-yaz deseni iki eşzamanlı harcamanın ikisinin de geçmesine
 * izin verirdi; şartlı UPDATE'te kaybeden taraf sıfır satır günceller ve
 * `false` alır.
 */
import type { PoolClient } from 'pg';
import { query } from '../db/pool.ts';
import { teams } from '@pitwall/shared/teams';
import { ECONOMY_SCALE } from '@pitwall/shared/economy';

export interface CarStats {
  motor: number;
  aero: number;
  grip: number;
}

export interface TeamEconomy {
  lobbyId: string;
  teamKey: string;
  rp: number;
  factoryLevels: Record<string, number>;
  car: CarStats;
  spyState: Record<string, unknown>;
  upgradesDone: Record<string, number>;
  updatedAt: Date;
}

interface Row {
  lobby_id: string;
  team_key: string;
  rp: number;
  factory_levels: Record<string, number>;
  car: CarStats;
  spy_state: Record<string, unknown>;
  upgrades_done: Record<string, number>;
  updated_at: Date;
}

const toEconomy = (r: Row): TeamEconomy => ({
  lobbyId: r.lobby_id,
  teamKey: r.team_key,
  rp: r.rp,
  factoryLevels: r.factory_levels,
  car: r.car,
  spyState: r.spy_state,
  upgradesDone: r.upgrades_done,
  updatedAt: r.updated_at,
});

const SELECT = `
  select lobby_id, team_key, rp, factory_levels, car, spy_state, upgrades_done, updated_at
    from lobby_economy
`;

/**
 * Sezon başı RP'si. Bir takım bir yarışta ~1.100 RP kazanıyor (ekonomi
 * belgesi); başlangıç kasası bunun iki katı, yani oyuncu ilk yarıştan önce bir
 * geliştirme başlatabilsin ama sezonu satın alamasın.
 */
export const STARTING_RP = Math.round(2200 * ECONOMY_SCALE);

/** Takımın ızgaradaki başlangıç aracı. `teams.ts` her takıma taban stat verir. */
function startingCar(teamKey: string): CarStats {
  const team = teams.find((t) => t.key === teamKey);
  if (!team) throw new Error(`unknown team: ${teamKey}`);
  return { motor: team.car.motor, aero: team.car.aero, grip: team.car.grip };
}

/**
 * Bir takımın ekonomisini kurar. Zaten varsa DOKUNMAZ — koltuk atama yeniden
 * denendiğinde ya da bir AI koltuğu insana devredildiğinde canlı bir ekonomiyi
 * sıfırlamak, oyuncunun bütün ilerlemesini sessizce silerdi.
 */
export async function seedTeamEconomy(
  client: PoolClient,
  lobbyId: string,
  teamKey: string,
): Promise<void> {
  await client.query(
    `insert into lobby_economy (lobby_id, team_key, rp, car)
     values ($1, $2, $3, $4)
     on conflict (lobby_id, team_key) do nothing`,
    [lobbyId, teamKey, STARTING_RP, JSON.stringify(startingCar(teamKey))],
  );
}

export async function loadTeamEconomy(lobbyId: string, teamKey: string): Promise<TeamEconomy | null> {
  const res = await query<Row>(`${SELECT} where lobby_id = $1 and team_key = $2`, [lobbyId, teamKey]);
  return res.rows[0] ? toEconomy(res.rows[0]) : null;
}

export async function loadLobbyEconomy(lobbyId: string): Promise<TeamEconomy[]> {
  const res = await query<Row>(`${SELECT} where lobby_id = $1 order by team_key`, [lobbyId]);
  return res.rows.map(toEconomy);
}

/** Bakiyeyi şartlı düşürür. Yetmiyorsa hiçbir şey değişmez ve `false` döner. */
export async function spendRp(
  client: PoolClient,
  lobbyId: string,
  teamKey: string,
  amount: number,
): Promise<boolean> {
  if (!Number.isInteger(amount) || amount < 0) throw new Error(`bad rp amount: ${amount}`);
  const res = await client.query(
    `update lobby_economy set rp = rp - $3, updated_at = now()
      where lobby_id = $1 and team_key = $2 and rp >= $3`,
    [lobbyId, teamKey, amount],
  );
  return res.rowCount === 1;
}

export async function addRp(
  client: PoolClient,
  lobbyId: string,
  teamKey: string,
  amount: number,
): Promise<void> {
  if (!Number.isInteger(amount) || amount < 0) throw new Error(`bad rp amount: ${amount}`);
  await client.query(
    `update lobby_economy set rp = rp + $3, updated_at = now()
      where lobby_id = $1 and team_key = $2`,
    [lobbyId, teamKey, amount],
  );
}

export async function setFactoryLevel(
  client: PoolClient,
  lobbyId: string,
  teamKey: string,
  code: string,
  level: number,
): Promise<void> {
  await client.query(
    `update lobby_economy
        set factory_levels = jsonb_set(factory_levels, array[$3], to_jsonb($4::int), true),
            updated_at = now()
      where lobby_id = $1 and team_key = $2`,
    [lobbyId, teamKey, code, level],
  );
}

/** Aracın bir stat'ını artırır (geliştirme claim'i buradan geçer). */
export async function bumpCarStat(
  client: PoolClient,
  lobbyId: string,
  teamKey: string,
  field: keyof CarStats,
  delta: number,
): Promise<void> {
  await client.query(
    `update lobby_economy
        set car = jsonb_set(car, array[$3], to_jsonb((car->>$3)::numeric + $4), true),
            updated_at = now()
      where lobby_id = $1 and team_key = $2`,
    [lobbyId, teamKey, field, delta],
  );
}

/** Bir geliştirme etiketinin kaç kez yapıldığını artırır (fiyat merdiveni). */
export async function bumpUpgradesDone(
  client: PoolClient,
  lobbyId: string,
  teamKey: string,
  label: string,
): Promise<void> {
  await client.query(
    `update lobby_economy
        set upgrades_done = jsonb_set(
              upgrades_done, array[$3],
              to_jsonb(coalesce((upgrades_done->>$3)::int, 0) + 1), true),
            updated_at = now()
      where lobby_id = $1 and team_key = $2`,
    [lobbyId, teamKey, label],
  );
}
```

`teams.ts`'in `car` alanının gerçek şeklini doğrula (`grep -n "car" shared/src/teams.ts`). Farklıysa `startingCar`'ı ona uydur ve ne bulduğunu raporla — **test beklentisini değiştirme**.

- [ ] **Step 4: Testi koş, geçtiğini gör**

```bash
cd /Users/berkay/Documents/My-Projects/pit-wall/server
DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test npm test -- --test-name-pattern="economy repo"
```
Expected: PASS — 7 test

- [ ] **Step 5: Commit**

```bash
git add src/economy/repo.ts test/economy-repo.test.ts
git commit -m "feat(server): lobi ekonomisi deposu ve şartlı RP harcaması"
```

---

## Görev 5: Ekonomiyi koltuk atamaya bağla

**Files:**
- Modify: `server/src/lobby/lobbyRepo.ts` (`createLobby` ve `takeSeat`)
- Test: `server/test/economy-seat.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

`server/test/economy-seat.test.ts`:

```ts
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool } from '../src/db/pool.ts';
import { createLobby, takeSeat } from '../src/lobby/lobbyRepo.ts';
import { loadLobbyEconomy, loadTeamEconomy } from '../src/economy/repo.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';

describe('economy follows the seat', () => {
  before(async () => { await runMigrations(); });
  beforeEach(async () => { await query('delete from lobbies'); await query('delete from users'); });
  after(async () => { await closePool(); });

  it('gives every one of the 11 teams an economy row when the lobby is created', async () => {
    const user = await createUserWithIdentity({
      base: 'GridHunter', provider: 'google', providerUid: 'g-seat-1', emailHash: null,
    });
    const created = await createLobby({
      userId: user.id, region: 'EU', visibility: 'private', aiDifficulty: 'normal',
      rankMin: 1, rankMax: 10, guestsCanInvite: false, midSeasonJoin: true,
    });
    assert.equal(created.ok, true);
    const rows = await loadLobbyEconomy(created.ok ? created.lobbyId : '');
    assert.equal(rows.length, 11, 'AI seats must have an economy too');
  });

  it('leaves the economy untouched when a human takes over an AI seat', async () => {
    const owner = await createUserWithIdentity({
      base: 'TurboKral', provider: 'google', providerUid: 'g-seat-2', emailHash: null,
    });
    const created = await createLobby({
      userId: owner.id, region: 'EU', visibility: 'private', aiDifficulty: 'normal',
      rankMin: 1, rankMax: 10, guestsCanInvite: false, midSeasonJoin: true,
    });
    const lobbyId = created.ok ? created.lobbyId : '';

    // AI takımın ekonomisini "yaşamış" hale getir.
    await query(`update lobby_economy set rp = 42 where lobby_id = $1 and team_key = 'meridian'`, [lobbyId]);

    const joiner = await createUserWithIdentity({
      base: 'DrsZone', provider: 'google', providerUid: 'g-seat-3', emailHash: null,
    });
    const taken = await takeSeat({ userId: joiner.id, lobbyId, teamKey: 'meridian', rankLevel: 5 });
    assert.equal(taken.ok, true);

    const econ = await loadTeamEconomy(lobbyId, 'meridian');
    assert.equal(econ!.rp, 42, 'taking over an AI seat reset its economy');
  });
});
```

`createLobby`'nin gerçek imzasını `grep -n "export async function createLobby" -A 15 src/lobby/lobbyRepo.ts` ile doğrula ve testi ona uydur. **Dönüş şeklini tahmin etme.**

- [ ] **Step 2: Testi koş, başarısız olduğunu gör**

Expected: FAIL — ekonomi satırı yok (`rows.length` 0)

- [ ] **Step 3: `createLobby`'ye tohumlamayı ekle**

`createLobby`'nin transaction'ı içinde, 11 koltuk `lobby_seats`'e yazıldıktan **sonra** ekle:

```ts
  // Her koltuğun ekonomisi lobiyle birlikte doğar. AI koltukları da dahil:
  // yarış motoru için insan ve AI arasında fark yok, ikisi de bir araca sahip.
  for (const team of teams) {
    await seedTeamEconomy(client, lobbyId, team.key);
  }
```

Dosyanın başına ekle:

```ts
import { seedTeamEconomy } from '../economy/repo.ts';
import { teams } from '@pitwall/shared/teams';
```

`teams` zaten import edilmişse tekrar etme.

- [ ] **Step 4: `takeSeat`'e savunma amaçlı tohumlama ekle**

`takeSeat` transaction'ında, koltuk UPDATE'i başarılı olduktan sonra ekle:

```ts
      // Lobi Faz 2'de kurulmuşsa ekonomi satırı yoktur; `on conflict do nothing`
      // olduğu için var olan bir ekonomiyi asla sıfırlamaz.
      await seedTeamEconomy(client, lobbyId, teamKey);
```

- [ ] **Step 5: Testi koş, geçtiğini gör**

```bash
DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test npm test -- --test-name-pattern="economy follows the seat"
```
Expected: PASS — 2 test

Tam paketi de koş; Faz 2'nin lobi testleri kırılmamalı:

```bash
DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test npm test
```

- [ ] **Step 6: Commit**

```bash
git add src/lobby/lobbyRepo.ts test/economy-seat.test.ts
git commit -m "feat(server): her koltuk lobiyle birlikte ekonomisini de alsın"
```

---

## Görev 6: `economy/jobs.ts` — claim modeli

**Files:**
- Create: `server/src/economy/jobs.ts`
- Test: `server/test/economy-jobs.test.ts`

> Bu planın kalbi. Testler sadece "çalışıyor mu" demiyor, **hile kapılarının kapalı olduğunu** kanıtlıyor.

- [ ] **Step 1: Başarısız testi yaz**

`server/test/economy-jobs.test.ts`:

```ts
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { seedTeamEconomy, loadTeamEconomy } from '../src/economy/repo.ts';
import { startJob, claimJob, skipJob, openJobs, JobError } from '../src/economy/jobs.ts';

async function makeLobby(): Promise<string> {
  const res = await query<{ id: string }>(
    `insert into lobbies (name, region, visibility, ai_difficulty, rank_min, rank_max,
                          guests_can_invite, mid_season_join, creator_user_id, next_race_at)
     values ('Jobs #1', 'EU', 'private', 'normal', 1, 10, false, true, null, now() + interval '1 day')
     returning id`,
  );
  await withTransaction((c) => seedTeamEconomy(c, res.rows[0].id, 'bosphorus'));
  return res.rows[0].id;
}

describe('economy jobs', () => {
  let lobbyId: string;
  before(async () => { await runMigrations(); });
  beforeEach(async () => { await query('delete from lobbies'); lobbyId = await makeLobby(); });
  after(async () => { await closePool(); });

  it('starts an upgrade, charges rp, and reports it as not ready', async () => {
    const before = (await loadTeamEconomy(lobbyId, 'bosphorus'))!.rp;
    const job = await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'upgrade', payload: { label: 'MOTOR' } });
    assert.equal(job.ok, true);
    const after = (await loadTeamEconomy(lobbyId, 'bosphorus'))!.rp;
    assert.ok(after < before, 'starting an upgrade did not charge rp');

    const open = await openJobs(lobbyId, 'bosphorus', new Date());
    assert.equal(open.length, 1);
    assert.equal(open[0].ready, false);
  });

  it('refuses a second upgrade while one is open', async () => {
    await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'upgrade', payload: { label: 'MOTOR' } });
    const second = await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'upgrade', payload: { label: 'AERO' } });
    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.reason, 'already_running');
  });

  it('REFUSES a claim before ends_at — the device clock cannot help', async () => {
    const job = await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'upgrade', payload: { label: 'MOTOR' } });
    const id = job.ok ? job.jobId : '';
    // İstemci "şimdi bitti" dese bile sunucu kendi saatine bakar.
    const res = await claimJob({ lobbyId, teamKey: 'bosphorus', jobId: id, now: new Date() });
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.reason, 'not_ready');
  });

  it('applies the upgrade exactly once, however many times it is claimed', async () => {
    const job = await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'upgrade', payload: { label: 'MOTOR' } });
    const id = job.ok ? job.jobId : '';
    await query(`update pending_jobs set ends_at = now() - interval '1 minute' where id = $1`, [id]);

    const motorBefore = (await loadTeamEconomy(lobbyId, 'bosphorus'))!.car.motor;
    const first = await claimJob({ lobbyId, teamKey: 'bosphorus', jobId: id, now: new Date() });
    assert.equal(first.ok, true);
    const motorAfter = (await loadTeamEconomy(lobbyId, 'bosphorus'))!.car.motor;
    assert.ok(motorAfter > motorBefore, 'claim did not improve the car');

    const second = await claimJob({ lobbyId, teamKey: 'bosphorus', jobId: id, now: new Date() });
    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.reason, 'already_claimed');
    assert.equal((await loadTeamEconomy(lobbyId, 'bosphorus'))!.car.motor, motorAfter, 'double claim applied twice');
  });

  it('survives two claims racing each other', async () => {
    const job = await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'upgrade', payload: { label: 'AERO' } });
    const id = job.ok ? job.jobId : '';
    await query(`update pending_jobs set ends_at = now() - interval '1 minute' where id = $1`, [id]);
    const aeroBefore = (await loadTeamEconomy(lobbyId, 'bosphorus'))!.car.aero;

    const [a, b] = await Promise.all([
      claimJob({ lobbyId, teamKey: 'bosphorus', jobId: id, now: new Date() }),
      claimJob({ lobbyId, teamKey: 'bosphorus', jobId: id, now: new Date() }),
    ]);
    assert.equal([a.ok, b.ok].filter(Boolean).length, 1, 'both claims succeeded');

    const aeroAfter = (await loadTeamEconomy(lobbyId, 'bosphorus'))!.car.aero;
    const delta = aeroAfter - aeroBefore;
    const single = delta;
    assert.ok(single > 0);
    // İkinci claim uygulanmış olsaydı artış iki katı olurdu.
    const rows = await query<{ n: string }>(
      `select count(*) as n from pending_jobs where id = $1 and claimed_at is not null`, [id],
    );
    assert.equal(rows.rows[0].n, '1');
  });

  it('refuses a claim for a job that belongs to another team', async () => {
    await withTransaction((c) => seedTeamEconomy(c, lobbyId, 'meridian'));
    const job = await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'upgrade', payload: { label: 'GRIP' } });
    const id = job.ok ? job.jobId : '';
    await query(`update pending_jobs set ends_at = now() - interval '1 minute' where id = $1`, [id]);
    const res = await claimJob({ lobbyId, teamKey: 'meridian', jobId: id, now: new Date() });
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.reason, 'not_found');
  });

  it('skip charges gold proportional to the time left and makes the job claimable', async () => {
    const job = await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'upgrade', payload: { label: 'MOTOR' } });
    const id = job.ok ? job.jobId : '';
    const cost = await skipJob({ lobbyId, teamKey: 'bosphorus', jobId: id, now: new Date() });
    assert.equal(cost.ok, true);
    assert.ok(cost.ok && cost.goldCost > 0, 'skipping a 22h job must cost gold');

    const open = await openJobs(lobbyId, 'bosphorus', new Date());
    assert.equal(open[0].ready, true, 'skip did not bring ends_at forward');
  });

  it('refuses an unknown job kind', async () => {
    await assert.rejects(
      // @ts-expect-error — bilinmeyen tür derleme zamanında da yakalanmalı
      () => startJob({ lobbyId, teamKey: 'bosphorus', kind: 'teleport', payload: {} }),
      JobError,
    );
  });
});
```

- [ ] **Step 2: Testi koş, başarısız olduğunu gör**

Expected: FAIL — `Cannot find module '../src/economy/jobs.ts'`

- [ ] **Step 3: `server/src/economy/jobs.ts` yaz**

```ts
/**
 * Zamanlayıcılar ve claim modeli. Spec §5.
 *
 * KURAL: `ends_at`'in geçmesi hiçbir şey YAZMAZ. Yalnızca bir eşiktir. Ekonomiye
 * yazan tek şey oyuncunun claim'idir ve o da `claimed_at` sayesinde
 * idempotenttir — ağ tekrarı, çift dokunuş ve yeniden gönderim zararsızdır.
 *
 * Bu tasarımın ikinci faydası: bildirim görevi ekonomiye hiç dokunmadığı için
 * kilitleme, birikmiş iş kuyruğu ve çifte uygulama koruması gerekmez.
 *
 * `now` her zaman DIŞARIDAN verilir. Bu modül saati kendisi okumaz; test sabit
 * bir an verebilsin ve istemcinin verdiği saate asla güvenilmesin diye.
 */
import { withTransaction, query } from '../db/pool.ts';
import { bumpCarStat, bumpUpgradesDone, loadTeamEconomy, spendRp, type CarStats } from './repo.ts';
import { skipCostGold } from '@pitwall/shared/economy';
import { factoryEffects } from '@pitwall/shared/factory';
import { spendGold } from '../gold/repo.ts';

export type JobKind = 'upgrade' | 'training' | 'spy';

export class JobError extends Error {
  constructor(message: string) { super(message); this.name = 'JobError'; }
}

export type StartError = 'already_running' | 'not_enough_rp' | 'no_economy' | 'bad_payload';
export type ClaimError = 'not_found' | 'not_ready' | 'already_claimed';
export type SkipError = 'not_found' | 'already_claimed' | 'not_enough_gold' | 'no_user';

export interface OpenJob {
  jobId: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  startedAt: Date;
  endsAt: Date;
  /** `now >= endsAt`. Hesaplanır, saklanmaz. */
  ready: boolean;
  /** Şimdi atlamanın Altın maliyeti. Biten iş için 0. */
  skipCostGold: number;
}

/** Araç geliştirmesinin süresi ve fiyatı, daha önce kaç kez yapıldığına göre. */
const UPGRADE_BASE_MS = 22 * 60 * 60 * 1000;
const UPGRADE_BASE_RP = 750;
const TRAINING_MS = 6 * 60 * 60 * 1000;
const SPY_MS = 24 * 60 * 60 * 1000;

/** Her tekrarda süre ve fiyat büyür: aynı stat'ı sonsuz ucuza pişiremezsin. */
const upgradeCost = (doneBefore: number): number => Math.round(UPGRADE_BASE_RP * 1.35 ** doneBefore);
const upgradeDuration = (doneBefore: number): number => Math.round(UPGRADE_BASE_MS * 1.15 ** doneBefore);

const STAT_OF: Record<string, keyof CarStats | undefined> = {
  MOTOR: 'motor', AERO: 'aero', GRIP: 'grip',
};

export interface StartInput {
  lobbyId: string;
  teamKey: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  now?: Date;
}

export type StartResult =
  | { ok: true; jobId: string; endsAt: Date; rpCost: number }
  | { ok: false; reason: StartError };

export async function startJob(input: StartInput): Promise<StartResult> {
  const { lobbyId, teamKey, kind, payload } = input;
  const now = input.now ?? new Date();
  if (kind !== 'upgrade' && kind !== 'training' && kind !== 'spy') {
    throw new JobError(`unknown job kind: ${String(kind)}`);
  }

  const econ = await loadTeamEconomy(lobbyId, teamKey);
  if (!econ) return { ok: false, reason: 'no_economy' };

  let rpCost = 0;
  let durationMs = 0;

  if (kind === 'upgrade') {
    const label = String(payload.label ?? '');
    if (!STAT_OF[label]) return { ok: false, reason: 'bad_payload' };
    const doneBefore = econ.upgradesDone[label] ?? 0;
    const effects = factoryEffects(econ.factoryLevels);
    rpCost = Math.round(upgradeCost(doneBefore) * effects.upgradeCostScale);
    durationMs = Math.round(upgradeDuration(doneBefore) * effects.upgradeTimeScale);
  } else if (kind === 'training') {
    const idx = Number(payload.driverIdx);
    if (!Number.isInteger(idx) || idx < 0 || idx > 5) return { ok: false, reason: 'bad_payload' };
    durationMs = TRAINING_MS;
  } else {
    durationMs = SPY_MS;
  }

  const endsAt = new Date(now.getTime() + durationMs);

  return withTransaction(async (client): Promise<StartResult> => {
    if (rpCost > 0 && !(await spendRp(client, lobbyId, teamKey, rpCost))) {
      return { ok: false, reason: 'not_enough_rp' };
    }
    const res = await client.query<{ id: string }>(
      `insert into pending_jobs (lobby_id, team_key, kind, payload, started_at, ends_at)
       values ($1, $2, $3, $4, $5, $6)
       on conflict do nothing
       returning id`,
      [lobbyId, teamKey, kind, JSON.stringify(payload), now, endsAt],
    );
    // Kısmi benzersiz indeks (aynı türden ikinci açık iş) çakışırsa sıfır satır
    // döner; RP harcaması da geri alınsın diye transaction'ı düşürüyoruz.
    if (!res.rows[0]) throw new AlreadyRunning();
    return { ok: true, jobId: res.rows[0].id, endsAt, rpCost };
  }).catch((err) => {
    if (err instanceof AlreadyRunning) return { ok: false, reason: 'already_running' as const };
    throw err;
  });
}

class AlreadyRunning extends Error {}

export interface ClaimInput {
  lobbyId: string;
  teamKey: string;
  jobId: string;
  now: Date;
}

export type ClaimResult =
  | { ok: true; kind: JobKind; applied: Record<string, unknown> }
  | { ok: false; reason: ClaimError };

/**
 * Biten işi uygular ve damgalar — tek transaction, tek kez.
 *
 * `claimed_at is null` şartı UPDATE'in kendisinde: iki eşzamanlı claim'den
 * biri sıfır satır günceller ve `already_claimed` alır. Önce oku-sonra-yaz
 * deseni ikisinin de uygulanmasına izin verirdi.
 */
export async function claimJob(input: ClaimInput): Promise<ClaimResult> {
  const { lobbyId, teamKey, jobId, now } = input;

  return withTransaction(async (client): Promise<ClaimResult> => {
    const claimed = await client.query<{ kind: JobKind; payload: Record<string, unknown> }>(
      `update pending_jobs set claimed_at = $4
        where id = $1 and lobby_id = $2 and team_key = $3
          and claimed_at is null and ends_at <= $4
        returning kind, payload`,
      [jobId, lobbyId, teamKey, now],
    );

    if (!claimed.rows[0]) {
      // Neden başarısız olduğunu ayırt et: yok mu, erken mi, zaten mi alınmış.
      const probe = await client.query<{ claimed_at: Date | null; ends_at: Date }>(
        `select claimed_at, ends_at from pending_jobs
          where id = $1 and lobby_id = $2 and team_key = $3`,
        [jobId, lobbyId, teamKey],
      );
      const row = probe.rows[0];
      if (!row) return { ok: false, reason: 'not_found' };
      if (row.claimed_at) return { ok: false, reason: 'already_claimed' };
      return { ok: false, reason: 'not_ready' };
    }

    const { kind, payload } = claimed.rows[0];

    if (kind === 'upgrade') {
      const label = String(payload.label ?? '');
      const field = STAT_OF[label];
      if (!field) throw new JobError(`claimed upgrade with a bad label: ${label}`);
      const econ = await loadTeamEconomy(lobbyId, teamKey);
      const gain = 2 + factoryEffects(econ?.factoryLevels ?? {}).upgradeGainBonus;
      await bumpCarStat(client, lobbyId, teamKey, field, gain);
      await bumpUpgradesDone(client, lobbyId, teamKey, label);
      return { ok: true, kind, applied: { label, gain } };
    }

    // Antrenman ve casusluk sürücü/istihbarat durumuna yazar; o durum Faz 3b'de
    // sunucuya taşınıyor. Şimdilik claim damgalanır ve sonuç payload'da döner,
    // böylece işin kendisi kaybolmaz.
    return { ok: true, kind, applied: { ...payload } };
  });
}

export interface SkipInput {
  lobbyId: string;
  teamKey: string;
  jobId: string;
  userId?: string;
  now: Date;
}

export type SkipResult =
  | { ok: true; goldCost: number }
  | { ok: false; reason: SkipError };

/** Kalan süreyi Altınla satın alır: `ends_at` şimdiye çekilir, iş claim'e hazır olur. */
export async function skipJob(input: SkipInput): Promise<SkipResult> {
  const { lobbyId, teamKey, jobId, userId, now } = input;

  const probe = await query<{ ends_at: Date; claimed_at: Date | null }>(
    `select ends_at, claimed_at from pending_jobs
      where id = $1 and lobby_id = $2 and team_key = $3`,
    [jobId, lobbyId, teamKey],
  );
  const row = probe.rows[0];
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.claimed_at) return { ok: false, reason: 'already_claimed' };

  const goldCost = skipCostGold(row.ends_at.getTime() - now.getTime());

  return withTransaction(async (client): Promise<SkipResult> => {
    if (goldCost > 0) {
      if (!userId) return { ok: false, reason: 'no_user' };
      if (!(await spendGold(client, userId, goldCost))) {
        return { ok: false, reason: 'not_enough_gold' };
      }
    }
    await client.query(
      `update pending_jobs set ends_at = $4
        where id = $1 and lobby_id = $2 and team_key = $3 and claimed_at is null`,
      [jobId, lobbyId, teamKey, now],
    );
    return { ok: true, goldCost };
  });
}

/** Bir takımın açık işleri, `now`'a göre hazır olup olmadıklarıyla. */
export async function openJobs(lobbyId: string, teamKey: string, now: Date): Promise<OpenJob[]> {
  const res = await query<{
    id: string; kind: JobKind; payload: Record<string, unknown>;
    started_at: Date; ends_at: Date;
  }>(
    `select id, kind, payload, started_at, ends_at
       from pending_jobs
      where lobby_id = $1 and team_key = $2 and claimed_at is null
      order by ends_at`,
    [lobbyId, teamKey],
  );
  return res.rows.map((r) => ({
    jobId: r.id,
    kind: r.kind,
    payload: r.payload,
    startedAt: r.started_at,
    endsAt: r.ends_at,
    ready: now.getTime() >= r.ends_at.getTime(),
    skipCostGold: skipCostGold(r.ends_at.getTime() - now.getTime()),
  }));
}
```

`spendGold` Görev 8'de yazılıyor; bu görevde `server/src/gold/repo.ts` henüz yoksa önce o dosyayı sadece `spendGold` ile oluştur, gerisini Görev 8'de tamamla. Bunu yaparsan raporla.

- [ ] **Step 4: Testi koş, geçtiğini gör**

```bash
DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test npm test -- --test-name-pattern="economy jobs"
```
Expected: PASS — 8 test

- [ ] **Step 5: Hile kapılarının GERÇEKTEN kapalı olduğunu kanıtla**

Bu adım atlanamaz. Her biri için önce kuralı boz, testin düştüğünü gör, sonra geri al:

1. `claimJob`'ın UPDATE'inden `and ends_at <= $4` şartını kaldır → "REFUSES a claim before ends_at" testi **düşmeli**.
2. `claimJob`'ın UPDATE'inden `and claimed_at is null` şartını kaldır → "applies the upgrade exactly once" testi **düşmeli**.
3. `spendRp`'nin `where`'inden `and rp >= $3` şartını kaldır → Görev 4'teki "refuses to spend more rp" testi **düşmeli**.

Üçünün de önce/sonra sonucunu raporla. Bir test bozulmuş kuralla da geçiyorsa, o test iddia ettiği şeyi test etmiyor demektir — bunu düzelt ve raporla.

- [ ] **Step 6: Commit**

```bash
git add src/economy/jobs.ts test/economy-jobs.test.ts
git commit -m "feat(server): claim modeli — ekonomiye yazan tek şey claim"
```

---

## Görev 7: `economy/value.ts` — takım değeri

**Files:**
- Create: `server/src/economy/value.ts`
- Test: `server/test/economy-value.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

`server/test/economy-value.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { teamValue } from '../src/economy/value.ts';

const base = {
  rp: 1000,
  car: { motor: 70, aero: 70, grip: 70 },
  factoryLevels: {} as Record<string, number>,
};

describe('team value', () => {
  it('is positive for a fresh team', () => {
    assert.ok(teamValue(base) > 0);
  });

  it('grows with the car', () => {
    const better = teamValue({ ...base, car: { motor: 90, aero: 90, grip: 90 } });
    assert.ok(better > teamValue(base));
  });

  it('grows with factory investment', () => {
    const invested = teamValue({ ...base, factoryLevels: { wind_tunnel: 3, engine_lab: 2 } });
    assert.ok(invested > teamValue(base));
  });

  it('counts banked rp', () => {
    assert.ok(teamValue({ ...base, rp: 50_000 }) > teamValue(base));
  });

  it('is a whole number — it is shown to the player as money', () => {
    assert.equal(Number.isInteger(teamValue(base)), true);
    assert.equal(Number.isInteger(teamValue({ ...base, factoryLevels: { wind_tunnel: 5 } })), true);
  });

  it('is deterministic', () => {
    assert.equal(teamValue(base), teamValue(base));
  });
});
```

- [ ] **Step 2: Testi koş, başarısız olduğunu gör**

Expected: FAIL — `Cannot find module '../src/economy/value.ts'`

- [ ] **Step 3: `server/src/economy/value.ts` yaz**

```ts
/**
 * Takım değeri — sezon arşivinin (Faz 4) göstereceği "toplam takım fiyatı".
 * Spec §9.
 *
 * Tek bir yerde hesaplanır ve istemci türetmez: iki tarafın ayrı hesaplaması,
 * oyuncunun ekranında gördüğü rakamla arşive yazılanın ayrışmasına yol açardı.
 *
 * Üç bileşen, hepsi RP cinsinden:
 *   - kasadaki RP, birebir
 *   - fabrikaya yatırılmış kümülatif maliyet (departmanların geri dönüşü yok,
 *     ama değerdirler)
 *   - aracın taban üstü puanının primi
 */
import { departmentCost, factoryDepartments } from '@pitwall/shared/factory';
import { ECONOMY_SCALE } from '@pitwall/shared/economy';

export interface ValueInput {
  rp: number;
  car: { motor: number; aero: number; grip: number };
  factoryLevels: Record<string, number>;
}

/** Izgaranın taban aracı; primin altında kalan kısım değer saymaz. */
const CAR_BASELINE = 55;

/** Taban üstü her araç puanının RP karşılığı. */
const CAR_POINT_VALUE = Math.round(120 * ECONOMY_SCALE);

export function teamValue(input: ValueInput): number {
  const factory = factoryDepartments.reduce((sum, d) => {
    const level = Math.max(0, input.factoryLevels[d.code] ?? 0);
    // Seviye n'e çıkmak 1..n seviyelerinin hepsinin bedelini ödemek demek.
    let spent = 0;
    for (let l = 1; l <= level; l += 1) spent += departmentCost(l);
    return sum + spent;
  }, 0);

  const carPoints = (['motor', 'aero', 'grip'] as const)
    .reduce((sum, k) => sum + Math.max(0, input.car[k] - CAR_BASELINE), 0);

  return Math.round(input.rp + factory + carPoints * CAR_POINT_VALUE);
}
```

`departmentCost`'un imzasını `grep -n "departmentCost" shared/src/factory.ts` ile doğrula — seviyeyi mi yoksa mevcut seviyeyi mi alıyor. Farklıysa döngüyü ona uydur ve raporla.

- [ ] **Step 4: Testi koş, geçtiğini gör**

```bash
npm test -- --test-name-pattern="team value"
```
Expected: PASS — 6 test

- [ ] **Step 5: Commit**

```bash
git add src/economy/value.ts test/economy-value.test.ts
git commit -m "feat(server): takım değeri tek kaynaktan hesaplansın"
```

---

## Görev 8: `gold/repo.ts` — Altın ve günlük tavanlar

**Files:**
- Create (ya da Görev 6'da başlatıldıysa tamamla): `server/src/gold/repo.ts`
- Test: `server/test/gold-repo.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

`server/test/gold-repo.test.ts`:

```ts
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { grantGold, spendGold, goldOf, capsFor, bumpAdsWatched, bumpGoldConverted } from '../src/gold/repo.ts';

async function makeUser(tag: string): Promise<string> {
  const u = await createUserWithIdentity({
    base: 'GripMaster', provider: 'google', providerUid: `g-${tag}`, emailHash: null,
  });
  return u.id;
}

describe('gold repo', () => {
  before(async () => { await runMigrations(); });
  beforeEach(async () => { await query('delete from users'); });
  after(async () => { await closePool(); });

  it('grants gold once per external id', async () => {
    const userId = await makeUser('g1');
    const first = await grantGold({ userId, source: 'ad', externalId: 'tx-1', gold: 1 });
    assert.equal(first.ok, true);
    assert.equal(await goldOf(userId), 1);

    const second = await grantGold({ userId, source: 'ad', externalId: 'tx-1', gold: 1 });
    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.reason, 'duplicate');
    assert.equal(await goldOf(userId), 1, 'the same callback granted gold twice');
  });

  it('treats the same external id under a different source as a different grant', async () => {
    const userId = await makeUser('g2');
    await grantGold({ userId, source: 'ad', externalId: 'shared-id', gold: 1 });
    const iap = await grantGold({ userId, source: 'iap', externalId: 'shared-id', gold: 60 });
    assert.equal(iap.ok, true);
    assert.equal(await goldOf(userId), 61);
  });

  it('refuses to spend more gold than the account has', async () => {
    const userId = await makeUser('g3');
    await grantGold({ userId, source: 'ad', externalId: 'tx-3', gold: 2 });
    const ok = await withTransaction((c) => spendGold(c, userId, 3));
    assert.equal(ok, false);
    assert.equal(await goldOf(userId), 2);
  });

  it('two concurrent spends cannot both succeed past the balance', async () => {
    const userId = await makeUser('g4');
    await grantGold({ userId, source: 'ad', externalId: 'tx-4', gold: 10 });
    const [a, b] = await Promise.all([
      withTransaction((c) => spendGold(c, userId, 7)),
      withTransaction((c) => spendGold(c, userId, 7)),
    ]);
    assert.equal([a, b].filter(Boolean).length, 1);
    assert.ok((await goldOf(userId)) >= 0);
  });

  it('counts caps against the SERVER day, not the caller day', async () => {
    const userId = await makeUser('g5');
    const day = new Date('2026-03-01T23:30:00Z');
    await bumpAdsWatched(userId, day, 3);
    const caps = await capsFor(userId, day);
    assert.equal(caps.adsWatched, 3);

    // Aynı UTC gününün başka bir anı aynı satıra düşer.
    const sameDay = await capsFor(userId, new Date('2026-03-01T00:10:00Z'));
    assert.equal(sameDay.adsWatched, 3);

    // Ertesi UTC günü sıfırdan başlar.
    const nextDay = await capsFor(userId, new Date('2026-03-02T00:10:00Z'));
    assert.equal(nextDay.adsWatched, 0);
  });

  it('accumulates converted gold within a day', async () => {
    const userId = await makeUser('g6');
    const day = new Date('2026-03-05T12:00:00Z');
    await bumpGoldConverted(userId, day, 2);
    await bumpGoldConverted(userId, day, 3);
    assert.equal((await capsFor(userId, day)).goldConverted, 5);
  });
});
```

- [ ] **Step 2: Testi koş, başarısız olduğunu gör**

- [ ] **Step 3: `server/src/gold/repo.ts` yaz**

```ts
/**
 * Altın ve günlük tavanlar. Spec §7.
 *
 * Altın hesap seviyesindedir (`users.gold`), RP lobi seviyesinde. Bir Altın
 * kaynağı (reklam callback'i, mağaza makbuzu) `gold_grants`'a tekil bir
 * `external_id` ile yazılır — aynı makbuzun iki kez Altın üretmesini
 * VERİTABANI engeller, uygulama mantığı değil.
 *
 * Günlük tavanın günü SUNUCU gününe (UTC) göredir. İstemcinin cihaz takvimini
 * değiştirerek tavanı sıfırlaması bu yüzden imkânsızdır.
 */
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db/pool.ts';

export type GoldSource = 'ad' | 'iap';

export interface GrantInput {
  userId: string;
  source: GoldSource;
  /** Callback'in transaction_id'si ya da mağaza makbuzunun jetonu. */
  externalId: string;
  gold: number;
}

export type GrantResult =
  | { ok: true; gold: number }
  | { ok: false; reason: 'duplicate' };

/** Postgres'in benzersizlik ihlali. */
const UNIQUE_VIOLATION = '23505';

export async function grantGold(input: GrantInput): Promise<GrantResult> {
  const { userId, source, externalId, gold } = input;
  if (!Number.isInteger(gold) || gold <= 0) throw new Error(`bad gold amount: ${gold}`);

  try {
    return await withTransaction(async (client): Promise<GrantResult> => {
      await client.query(
        `insert into gold_grants (user_id, source, external_id, gold) values ($1, $2, $3, $4)`,
        [userId, source, externalId, gold],
      );
      await client.query('update users set gold = gold + $2 where id = $1', [userId, gold]);
      return { ok: true, gold };
    });
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) return { ok: false, reason: 'duplicate' };
    throw err;
  }
}

/** Bakiyeyi şartlı düşürür; yetmiyorsa hiçbir şey değişmez. */
export async function spendGold(client: PoolClient, userId: string, amount: number): Promise<boolean> {
  if (!Number.isInteger(amount) || amount < 0) throw new Error(`bad gold amount: ${amount}`);
  if (amount === 0) return true;
  const res = await client.query(
    'update users set gold = gold - $2 where id = $1 and gold >= $2',
    [userId, amount],
  );
  return res.rowCount === 1;
}

export async function goldOf(userId: string): Promise<number> {
  const res = await query<{ gold: number }>('select gold from users where id = $1', [userId]);
  return res.rows[0]?.gold ?? 0;
}

export interface DailyCaps {
  adsWatched: number;
  goldConverted: number;
}

/** `at`'in UTC gününün tavan satırı. Satır yoksa sıfırlar döner. */
export async function capsFor(userId: string, at: Date): Promise<DailyCaps> {
  const res = await query<{ ads_watched: number; gold_converted: number }>(
    `select ads_watched, gold_converted from daily_caps
      where user_id = $1 and day = ($2::timestamptz at time zone 'UTC')::date`,
    [userId, at],
  );
  const row = res.rows[0];
  return { adsWatched: row?.ads_watched ?? 0, goldConverted: row?.gold_converted ?? 0 };
}

export async function bumpAdsWatched(userId: string, at: Date, by = 1): Promise<void> {
  await query(
    `insert into daily_caps (user_id, day, ads_watched)
     values ($1, ($2::timestamptz at time zone 'UTC')::date, $3)
     on conflict (user_id, day) do update set ads_watched = daily_caps.ads_watched + $3`,
    [userId, at, by],
  );
}

export async function bumpGoldConverted(userId: string, at: Date, by: number): Promise<void> {
  await query(
    `insert into daily_caps (user_id, day, gold_converted)
     values ($1, ($2::timestamptz at time zone 'UTC')::date, $3)
     on conflict (user_id, day) do update set gold_converted = daily_caps.gold_converted + $3`,
    [userId, at, by],
  );
}
```

- [ ] **Step 4: Testi koş, geçtiğini gör**

Expected: PASS — 6 test

- [ ] **Step 5: Commit**

```bash
git add src/gold/repo.ts test/gold-repo.test.ts
git commit -m "feat(server): altın deposu, tekil musluk kaydı ve sunucu günü tavanları"
```

---

## Görev 9: `gold/ssv.ts` — AdMob sunucu-taraflı doğrulama

**Files:**
- Create: `server/src/gold/ssv.ts`
- Test: `server/test/gold-ssv.test.ts`

> Bu görev olmadan Altını sunucuya taşımak tiyatro olur: istemci "reklam izledim" deyince Altın verilmeye devam ederdi.

- [ ] **Step 1: AdMob SSV'nin gerçek şeklini doğrula**

Uygulamadan önce Google'ın dokümantasyonunu oku ve raporla:

- Callback bir **GET** isteğidir; sorgu parametreleri arasında `ad_network`, `ad_unit`, `custom_data`, `key_id`, `reward_amount`, `reward_item`, `signature`, `timestamp`, `transaction_id`, `user_id` bulunur.
- İmza **ECDSA**'dır ve sorgu dizesinin `signature=` parametresinden ÖNCEKİ kısmı üzerinden hesaplanır.
- Açık anahtarlar `https://gstatic.com/admob/reward/verifier-keys.json` adresinden alınır ve `key_id` ile eşleştirilir.

Bu üç maddenin hepsini doğrula. Doküman farklı söylüyorsa **dokümana uy** ve farkı raporla — bu prompt'taki tarife değil.

- [ ] **Step 2: Başarısız testi yaz**

`server/test/gold-ssv.test.ts`:

```ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { verifySsvCallback, __setVerifierKeysUrl } from '../src/gold/ssv.ts';
import { createServer, type Server } from 'node:http';

/** Test kendi anahtar çiftini üretir; gerçek Google uçlarına hiç gidilmez. */
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KEY_ID = '1234567890';

let keyServer: Server;

function signQuery(qs: string): string {
  const signer = createSign('SHA256');
  signer.update(qs);
  return signer.sign(privateKey).toString('base64url');
}

/** `signature` ve `key_id` HARİÇ her şeyi taşıyan sorgu dizesi. */
const BODY = 'ad_network=5450213213286189855&ad_unit=1234&reward_amount=1&reward_item=gold'
  + '&timestamp=1700000000000&transaction_id=abc123&user_id=user-1';

describe('admob ssv', () => {
  before(async () => {
    const jwk = publicKey.export({ format: 'jwk' });
    keyServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [{ keyId: Number(KEY_ID), pem: publicKey.export({ type: 'spki', format: 'pem' }), base64: Buffer.from(JSON.stringify(jwk)).toString('base64') }] }));
    });
    await new Promise<void>((r) => keyServer.listen(0, r));
    const port = (keyServer.address() as { port: number }).port;
    __setVerifierKeysUrl(`http://127.0.0.1:${port}/keys`);
  });
  after(async () => { await new Promise<void>((r) => keyServer.close(() => r())); });

  it('accepts a correctly signed callback', async () => {
    const qs = `${BODY}&key_id=${KEY_ID}`;
    const signature = signQuery(qs);
    const res = await verifySsvCallback(`${qs}&signature=${signature}`);
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.transactionId, 'abc123');
    assert.equal(res.ok && res.userId, 'user-1');
    assert.equal(res.ok && res.rewardAmount, 1);
  });

  it('REJECTS a tampered reward amount', async () => {
    const qs = `${BODY}&key_id=${KEY_ID}`;
    const signature = signQuery(qs);
    const tampered = qs.replace('reward_amount=1', 'reward_amount=9999');
    const res = await verifySsvCallback(`${tampered}&signature=${signature}`);
    assert.equal(res.ok, false);
  });

  it('REJECTS a missing signature', async () => {
    const res = await verifySsvCallback(`${BODY}&key_id=${KEY_ID}`);
    assert.equal(res.ok, false);
  });

  it('REJECTS an unknown key id', async () => {
    const qs = `${BODY}&key_id=9999999`;
    const res = await verifySsvCallback(`${qs}&signature=${signQuery(qs)}`);
    assert.equal(res.ok, false);
  });

  it('REJECTS a callback with no transaction id', async () => {
    const body = BODY.replace('&transaction_id=abc123', '');
    const qs = `${body}&key_id=${KEY_ID}`;
    const res = await verifySsvCallback(`${qs}&signature=${signQuery(qs)}`);
    assert.equal(res.ok, false);
  });
});
```

- [ ] **Step 3: `server/src/gold/ssv.ts` yaz**

Adım 1'de doğruladığın şekle göre yaz. Gereken davranış:

- `verifySsvCallback(rawQueryString)` → `{ok: true, transactionId, userId, rewardAmount} | {ok: false, reason}`
- İmzalanan metin, sorgu dizesinin `&signature=` parametresinden önceki kısmıdır.
- Açık anahtarlar bir kez çekilip önbelleklenir; `key_id` eşleşmezse bir kez yeniden çekilir (Google anahtar döndürür), yine eşleşmezse reddedilir.
- `__setVerifierKeysUrl(url)` test tohumu, önbelleği temizler.
- **Hiçbir yolda fırlatmaz**, her zaman sonuç nesnesi döner.
- **Hiçbir log satırı `signature`'ı veya sorgu dizesinin tamamını yazmaz** — imza bir kimlik bilgisidir.

- [ ] **Step 4: Testi koş, geçtiğini gör**

Expected: PASS — 5 test

- [ ] **Step 5: İmza kontrolünün gerçekten çalıştığını kanıtla**

İmza doğrulamasını geçici olarak `return true` yap → "REJECTS a tampered reward amount" testi **düşmeli**. Geri al ve iki sonucu da raporla. Test bozuk kontrolle de geçiyorsa saldırıyı test etmiyordur.

- [ ] **Step 6: Commit**

```bash
git add src/gold/ssv.ts test/gold-ssv.test.ts
git commit -m "feat(server): AdMob ödül callback'inin imza doğrulaması"
```

---

## Görev 10: `gold/receipts.ts` — mağaza makbuzu doğrulaması

**Files:**
- Create: `server/src/gold/receipts.ts`
- Test: `server/test/gold-receipts.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

`server/test/gold-receipts.test.ts`:

```ts
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { verifyReceipt } from '../src/gold/receipts.ts';

const realFetch = globalThis.fetch;

const stub = (handler: (url: string) => { status: number; body: unknown }) => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const { status, body } = handler(String(input));
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
};

describe('store receipts', () => {
  beforeEach(() => {
    process.env.APPLE_SHARED_SECRET = 'test-secret';
    process.env.GOOGLE_PLAY_PACKAGE = 'com.yberkayarda.pitwall';
  });
  after(() => { globalThis.fetch = realFetch; });

  it('accepts a valid apple receipt and reports the sku and transaction id', async () => {
    stub(() => ({
      status: 200,
      body: { status: 0, receipt: { in_app: [{ product_id: 'com.yberkayarda.pitwall.gold5', transaction_id: 'apple-tx-1' }] } },
    }));
    const res = await verifyReceipt({ platform: 'apple', receipt: 'base64-blob' });
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.sku, 'com.yberkayarda.pitwall.gold5');
    assert.equal(res.ok && res.transactionId, 'apple-tx-1');
  });

  it('REJECTS an apple receipt with a non-zero status', async () => {
    stub(() => ({ status: 200, body: { status: 21002 } }));
    const res = await verifyReceipt({ platform: 'apple', receipt: 'bad' });
    assert.equal(res.ok, false);
  });

  it('REJECTS when apple returns http 500', async () => {
    stub(() => ({ status: 500, body: {} }));
    const res = await verifyReceipt({ platform: 'apple', receipt: 'x' });
    assert.equal(res.ok, false);
  });

  it('accepts a purchased google receipt', async () => {
    stub(() => ({ status: 200, body: { purchaseState: 0, orderId: 'GPA.1234', acknowledgementState: 0 } }));
    const res = await verifyReceipt({
      platform: 'google', receipt: 'token-1', sku: 'com.yberkayarda.pitwall.gold15',
    });
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.transactionId, 'GPA.1234');
  });

  it('REJECTS a google receipt that is not in the purchased state', async () => {
    stub(() => ({ status: 200, body: { purchaseState: 1, orderId: 'GPA.9999' } }));
    const res = await verifyReceipt({
      platform: 'google', receipt: 'token-2', sku: 'com.yberkayarda.pitwall.gold15',
    });
    assert.equal(res.ok, false);
  });

  it('REJECTS an unknown sku even when the store says the purchase is valid', async () => {
    stub(() => ({
      status: 200,
      body: { status: 0, receipt: { in_app: [{ product_id: 'com.attacker.free.gold', transaction_id: 't' }] } },
    }));
    const res = await verifyReceipt({ platform: 'apple', receipt: 'x' });
    assert.equal(res.ok, false, 'an sku we never sold must never grant gold');
  });

  it('never throws, even on a network failure', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    const res = await verifyReceipt({ platform: 'apple', receipt: 'x' });
    assert.equal(res.ok, false);
  });
});
```

- [ ] **Step 2: Testi koş, başarısız olduğunu gör**

- [ ] **Step 3: `server/src/gold/receipts.ts` yaz**

Gereken davranış:

- `verifyReceipt({platform, receipt, sku?})` → `{ok: true, sku, transactionId, gold} | {ok: false, reason}`
- Apple: `https://buy.itunes.apple.com/verifyReceipt`'e POST; `status: 21007` gelirse sandbox ucuna (`https://sandbox.itunes.apple.com/verifyReceipt`) yeniden dener — Apple'ın belgelediği akış budur.
- Google: Play Developer API ile `purchaseState === 0` kontrolü.
- **SKU beyaz listesi:** dönen ürün kimliği `shared/economy.ts`'teki `goldPacks`'ta yoksa reddedilir. Mağaza "geçerli" dese bile satmadığımız bir ürün Altın üretemez.
- Verilecek Altın miktarı **her zaman** `goldPacks`'tan okunur, asla istemciden ya da mağaza yanıtından gelen bir sayıdan.
- Her iki uca da `AbortSignal.timeout(5000)` ile gidilir.
- Hiçbir yolda fırlatmaz; makbuz içeriği ve paylaşılan sır hiçbir log satırına düşmez.

- [ ] **Step 4: Testi koş, geçtiğini gör**

Expected: PASS — 7 test

- [ ] **Step 5: Commit**

```bash
git add src/gold/receipts.ts test/gold-receipts.test.ts
git commit -m "feat(server): mağaza makbuzu doğrulaması ve SKU beyaz listesi"
```

---

## Görev 11: `economy/state.ts` — slot durumu yanıtı

**Files:**
- Create: `server/src/economy/state.ts`
- Test: `server/test/economy-state.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

`server/test/economy-state.test.ts`:

```ts
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { seedTeamEconomy } from '../src/economy/repo.ts';
import { startJob } from '../src/economy/jobs.ts';
import { buildSlotState } from '../src/economy/state.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';

async function makeLobby(): Promise<string> {
  const res = await query<{ id: string }>(
    `insert into lobbies (name, region, visibility, ai_difficulty, rank_min, rank_max,
                          guests_can_invite, mid_season_join, creator_user_id, next_race_at)
     values ('State #1', 'EU', 'private', 'normal', 1, 10, false, true, null, now() + interval '1 day')
     returning id`,
  );
  await withTransaction((c) => seedTeamEconomy(c, res.rows[0].id, 'bosphorus'));
  return res.rows[0].id;
}

describe('slot state', () => {
  let lobbyId: string;
  let userId: string;
  before(async () => { await runMigrations(); });
  beforeEach(async () => {
    await query('delete from lobbies'); await query('delete from users');
    lobbyId = await makeLobby();
    userId = (await createUserWithIdentity({
      base: 'HotLapHero', provider: 'google', providerUid: 'g-state-1', emailHash: null,
    })).id;
  });
  after(async () => { await closePool(); });

  it('carries serverNow so the client never trusts its own clock', async () => {
    const before = Date.now();
    const state = await buildSlotState({ lobbyId, teamKey: 'bosphorus', userId, now: new Date() });
    const after = Date.now();
    const serverNow = Date.parse(state.serverNow);
    assert.ok(serverNow >= before && serverNow <= after, 'serverNow is not the server clock');
  });

  it('reports rp, gold, car, factory and team value together', async () => {
    const state = await buildSlotState({ lobbyId, teamKey: 'bosphorus', userId, now: new Date() });
    assert.ok(state.rp > 0);
    assert.equal(state.gold, 0);
    assert.ok(state.car.motor > 0);
    assert.deepEqual(state.factory, {});
    assert.ok(state.teamValue > 0);
  });

  it('lists open jobs with readiness computed from the server clock', async () => {
    await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'upgrade', payload: { label: 'MOTOR' } });
    const now = new Date();
    const state = await buildSlotState({ lobbyId, teamKey: 'bosphorus', userId, now });
    assert.equal(state.jobs.length, 1);
    assert.equal(state.jobs[0].ready, false);
    assert.ok(state.jobs[0].skipCostGold > 0);

    const later = new Date(now.getTime() + 23 * 60 * 60 * 1000);
    const readyState = await buildSlotState({ lobbyId, teamKey: 'bosphorus', userId, now: later });
    assert.equal(readyState.jobs[0].ready, true);
    assert.equal(readyState.jobs[0].skipCostGold, 0);
  });

  it('reports the daily caps left', async () => {
    const state = await buildSlotState({ lobbyId, teamKey: 'bosphorus', userId, now: new Date() });
    assert.ok(state.caps.adsLeft > 0);
    assert.ok(state.caps.convertibleLeft > 0);
  });

  it('carries no email, no token and no internal ids the client cannot use', async () => {
    const state = await buildSlotState({ lobbyId, teamKey: 'bosphorus', userId, now: new Date() });
    const text = JSON.stringify(state);
    assert.ok(!text.includes('@'), 'an email-shaped value reached the slot state');
    assert.ok(!/password|token|secret/i.test(text));
  });
});
```

- [ ] **Step 2: Testi koş, başarısız olduğunu gör**

- [ ] **Step 3: `server/src/economy/state.ts` yaz**

```ts
/**
 * Slot durumu yanıtı. Spec §3.
 *
 * Her eylem bu yapının TAMAMINI döner: istemci hiçbir şey türetmez, geleni
 * çizer. Granular yanıtlar yerine bu seçildi çünkü kısmi güncelleme kaçırmak
 * ve iki tarafın ayrışması böylece yapısal olarak imkânsız hale geliyor.
 *
 * `serverNow` her yanıtta vardır: istemci geri sayımı kendi saatinden değil,
 * bu değerle arasındaki farktan hesaplar. Cihaz saatini ileri almak hiçbir şey
 * kazandırmaz.
 */
import { loadTeamEconomy, type CarStats } from './repo.ts';
import { openJobs, type OpenJob } from './jobs.ts';
import { teamValue } from './value.ts';
import { capsFor, goldOf } from '../gold/repo.ts';
import { ADS_PER_DAY, GOLD_TO_RP_DAILY_CAP } from '@pitwall/shared/economy';

export interface SlotStateJob {
  jobId: string;
  kind: OpenJob['kind'];
  payload: Record<string, unknown>;
  endsAt: string;
  ready: boolean;
  skipCostGold: number;
}

export interface SlotState {
  serverNow: string;
  lobbyId: string;
  teamKey: string;
  rp: number;
  gold: number;
  car: CarStats;
  factory: Record<string, number>;
  upgradesDone: Record<string, number>;
  jobs: SlotStateJob[];
  teamValue: number;
  caps: { adsLeft: number; convertibleLeft: number };
}

export interface SlotStateInput {
  lobbyId: string;
  teamKey: string;
  userId: string;
  now: Date;
}

export async function buildSlotState(input: SlotStateInput): Promise<SlotState> {
  const { lobbyId, teamKey, userId, now } = input;

  const [econ, jobs, gold, caps] = await Promise.all([
    loadTeamEconomy(lobbyId, teamKey),
    openJobs(lobbyId, teamKey, now),
    goldOf(userId),
    capsFor(userId, now),
  ]);
  if (!econ) throw new Error(`no economy for ${lobbyId}/${teamKey}`);

  return {
    serverNow: now.toISOString(),
    lobbyId,
    teamKey,
    rp: econ.rp,
    gold,
    car: econ.car,
    factory: econ.factoryLevels,
    upgradesDone: econ.upgradesDone,
    jobs: jobs.map((j) => ({
      jobId: j.jobId,
      kind: j.kind,
      payload: j.payload,
      endsAt: j.endsAt.toISOString(),
      ready: j.ready,
      skipCostGold: j.skipCostGold,
    })),
    teamValue: teamValue({ rp: econ.rp, car: econ.car, factoryLevels: econ.factoryLevels }),
    caps: {
      adsLeft: Math.max(0, ADS_PER_DAY - caps.adsWatched),
      convertibleLeft: Math.max(0, GOLD_TO_RP_DAILY_CAP - caps.goldConverted),
    },
  };
}
```

- [ ] **Step 4: Testi koş, geçtiğini gör**

Expected: PASS — 5 test

- [ ] **Step 5: Commit**

```bash
git add src/economy/state.ts test/economy-state.test.ts
git commit -m "feat(server): slot durumu yanıtı ve serverNow"
```

---

## Görev 12: `economy/actions.ts` ve `economy/routes.ts` — eylem ucu

**Files:**
- Create: `server/src/economy/actions.ts`, `server/src/economy/routes.ts`
- Modify: `server/src/index.ts` (yeni rotaların bağlanması)
- Test: `server/test/economy-http.test.ts`

> **UYARI — daha önceki bir incelemeden:** Yönlendirici 500 yolunda fırlatılan hatayı sadakatle logluyor. Bir handler `new Error(\`... ${JSON.stringify(ctx.body)}\`)` fırlatırsa **gövde log'a düşer**. Bu uçların gövdesinde makbuz ve kullanıcı kimliği var. **Hiçbir hata mesajına, log satırına veya yanıta `ctx.body` interpolasyonu yapma.**

- [ ] **Step 1: Başarısız testi yaz**

`server/test/economy-http.test.ts`:

```ts
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Router } from '../src/http/router.ts';
import { registerEconomyRoutes } from '../src/economy/routes.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { createUserWithIdentity } from '../src/auth/userRepo.ts';
import { signSession } from '../src/auth/jwt.ts';
import { seedTeamEconomy } from '../src/economy/repo.ts';

let server: Server;
let base: string;
let lobbyId: string;
let userId: string;
let token: string;

const act = (body: unknown, bearer = token) =>
  fetch(`${base}/lobby/${lobbyId}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });

describe('economy http', () => {
  before(async () => {
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-32b';
    process.env.EMAIL_HASH_PEPPER = 'test-pepper';
    await runMigrations();
    const router = new Router();
    registerEconomyRoutes(router);
    server = createServer(async (req, res) => {
      if (await router.handle(req, res)) return;
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  beforeEach(async () => {
    await query('delete from lobbies'); await query('delete from users');
    const user = await createUserWithIdentity({
      base: 'PaddockKing', provider: 'google', providerUid: 'g-http-1', emailHash: null,
    });
    userId = user.id;
    token = await signSession(userId);
    const res = await query<{ id: string }>(
      `insert into lobbies (name, region, visibility, ai_difficulty, rank_min, rank_max,
                            guests_can_invite, mid_season_join, creator_user_id, next_race_at)
       values ('Http #1', 'EU', 'private', 'normal', 1, 10, false, true, $1, now() + interval '1 day')
       returning id`, [userId],
    );
    lobbyId = res.rows[0].id;
    await withTransaction((c) => seedTeamEconomy(c, lobbyId, 'bosphorus'));
    await query(
      `insert into lobby_seats (lobby_id, team_key, user_id, managed, joined_at)
       values ($1, 'bosphorus', $2, 'human', now())
       on conflict (lobby_id, team_key) do update set user_id = $2, managed = 'human'`,
      [lobbyId, userId],
    );
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await closePool();
  });

  it('requires a session', async () => {
    assert.equal((await act({ type: 'startUpgrade', label: 'MOTOR' }, 'garbage')).status, 401);
  });

  it('refuses a player who holds no seat in the lobby', async () => {
    const other = await createUserWithIdentity({
      base: 'CornerCutter', provider: 'google', providerUid: 'g-http-2', emailHash: null,
    });
    const otherToken = await signSession(other.id);
    assert.equal((await act({ type: 'startUpgrade', label: 'MOTOR' }, otherToken)).status, 403);
  });

  it('starts an upgrade and returns the whole slot state', async () => {
    const res = await act({ type: 'startUpgrade', label: 'MOTOR' });
    assert.equal(res.status, 200);
    const body = await res.json() as { serverNow: string; rp: number; jobs: unknown[] };
    assert.ok(Date.parse(body.serverNow) > 0);
    assert.equal(body.jobs.length, 1);
  });

  it('rejects an unknown action with 400, not 500', async () => {
    const res = await act({ type: 'teleport' });
    assert.equal(res.status, 400);
    assert.equal((await res.json() as { error: string }).error, 'unknown_action');
  });

  it('rejects an early claim with 409 and a specific code', async () => {
    const started = await act({ type: 'startUpgrade', label: 'MOTOR' });
    const body = await started.json() as { jobs: { jobId: string }[] };
    const res = await act({ type: 'claimUpgrade', jobId: body.jobs[0].jobId });
    assert.equal(res.status, 409);
    assert.equal((await res.json() as { error: string }).error, 'not_ready');
  });

  it('rejects a second upgrade with 409 while one is open', async () => {
    await act({ type: 'startUpgrade', label: 'MOTOR' });
    const res = await act({ type: 'startUpgrade', label: 'AERO' });
    assert.equal(res.status, 409);
    assert.equal((await res.json() as { error: string }).error, 'already_running');
  });

  it('never echoes the request body back to the client', async () => {
    const res = await act({ type: 'teleport', secretProbe: 'do-not-echo-me' });
    assert.ok(!(await res.text()).includes('do-not-echo-me'));
  });
});
```

- [ ] **Step 2: Testi koş, başarısız olduğunu gör**

- [ ] **Step 3: `server/src/economy/actions.ts` yaz**

Gereken davranış:

- `runAction({lobbyId, userId, teamKey, body, now})` → `{ok: true, state: SlotState} | {ok: false, code}`
- `body.type`'a göre `startJob` / `claimJob` / `skipJob` / fabrika yükseltmesi / Altın→RP dönüşümü çağırır.
- Bilinmeyen `type` → `unknown_action`.
- Her başarılı eylemden sonra `buildSlotState` çağrılır ve **tam durum** döner.
- Gövde alanları savunmacı okunur: string olmayan bir `label` çökme değil `bad_payload` üretir.
- Hiçbir hata mesajı gövdeyi interpolate etmez.

`convertGoldToRp` şunu yapar: günlük tavanı `capsFor` ile okur, izin verilen miktarı hesaplar, `spendGold` ve `addRp`'yi **tek transaction'da** çağırır, `bumpGoldConverted` ile tavanı işler.

- [ ] **Step 4: `server/src/economy/routes.ts` yaz**

- `POST /lobby/:lobbyId/action` — `Router` düz yol eşleştirmesi yaptığı için yol parametresi desteği gerekir. Mevcut `Router`'ı incele: parametre desteği yoksa **gövdeye `lobbyId` alanı** koy (`POST /lobby/action`) ve bunu raporla — yönlendiriciyi bu görevde yeniden yazma.
- Oturum `verifySession` ile doğrulanır; yoksa 401.
- Oyuncunun o lobide koltuğu olup olmadığı `lobby_seats`'ten kontrol edilir; yoksa 403. **Takım anahtarı istemciden ALINMAZ** — koltuk satırından okunur, yoksa oyuncu başka takımın ekonomisine yazabilirdi.
- Hata kodu → HTTP: `unknown_action`/`bad_payload` → 400, `not_ready`/`already_claimed`/`already_running`/`not_enough_rp`/`not_enough_gold` → 409, oturum yok → 401, koltuk yok → 403.

- [ ] **Step 5: Rotaları sunucuya bağla**

`server/src/index.ts`'te mevcut router kurulumuna ekle:

```ts
import { registerEconomyRoutes } from './economy/routes.ts';
registerEconomyRoutes(router);
```

- [ ] **Step 6: Testi koş, tam paketi koş, tip denetimi**

```bash
DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test npm test
npm run typecheck
```
Expected: hepsi geçiyor.

- [ ] **Step 7: Takım anahtarının istemciden alınmadığını KANITLA**

`teamKey`'i gövdeden okuyacak şekilde geçici olarak değiştir ve "refuses a player who holds no seat" testinin hâlâ geçtiğini gör — geçiyorsa test bu saldırıyı kapsamıyor demektir. O durumda şu testi ekle: oyuncu kendi koltuğu varken gövdede **başka** bir takım anahtarı gönderir; sunucu kendi koltuğunu kullanmalı, gövdedekini değil. Geri al ve raporla.

- [ ] **Step 8: Commit**

```bash
git add src/economy/actions.ts src/economy/routes.ts src/index.ts test/economy-http.test.ts
git commit -m "feat(server): ekonomi eylem ucu ve slot durumu yanıtı"
```

---

## Görev 13: `gold/routes.ts` — SSV callback ve makbuz ucu

**Files:**
- Create: `server/src/gold/routes.ts`
- Modify: `server/src/index.ts`
- Test: `server/test/gold-http.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

Kapsaması gerekenler:

- `GET /gold/admob-ssv?...` — geçerli imzalı callback Altın yazar ve **200** döner; aynı `transaction_id` ikinci kez gelirse yine 200 döner (Google tekrar dener) ama Altın **artmaz**.
- Geçersiz imza → 403 ve Altın yazılmaz.
- `POST /gold/purchase` (oturum gerekir) — geçerli makbuz Altın yazar; aynı makbuz ikinci kez Altın yazmaz; bilinmeyen SKU reddedilir.
- Hiçbir yanıt ve hiçbir log satırı imzayı, makbuzu veya paylaşılan sırrı içermez.

Testler `verifySsvCallback` ve `verifyReceipt`'i enjekte edilebilir bağımlılık olarak alsın ki ağ kullanılmasın — rotaları yazarken bu enjeksiyonu `registerGoldRoutes(router, deps?)` şeklinde tasarla.

- [ ] **Step 2–4: Koş (FAIL) → yaz → koş (PASS)**

`GET /gold/admob-ssv` için kritik ayrıntı: **Google tekrarı bekler.** Yinelenen `transaction_id`'de 4xx dönmek Google'ı sonsuz tekrara sokar; 200 dön ve Altın yazma. Bunu bir yorum satırıyla kodda açıkla.

- [ ] **Step 5: Commit**

```bash
git add src/gold/routes.ts src/index.ts test/gold-http.test.ts
git commit -m "feat(server): altın musluğu uçları — SSV callback ve makbuz"
```

---

## Görev 14: `notify/scheduler.ts` — bildirim görevi

**Files:**
- Create: `server/src/notify/scheduler.ts`
- Test: `server/test/notify-scheduler.test.ts`

> Bu görevin tek kuralı var ve testi de onu kanıtlıyor: **ekonomiye hiçbir şey yazmaz.**

- [ ] **Step 1: Başarısız testi yaz**

`server/test/notify-scheduler.test.ts`:

```ts
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool, withTransaction } from '../src/db/pool.ts';
import { seedTeamEconomy } from '../src/economy/repo.ts';
import { startJob } from '../src/economy/jobs.ts';
import { sweepReadyJobs } from '../src/notify/scheduler.ts';

async function makeLobby(): Promise<string> {
  const res = await query<{ id: string }>(
    `insert into lobbies (name, region, visibility, ai_difficulty, rank_min, rank_max,
                          guests_can_invite, mid_season_join, creator_user_id, next_race_at)
     values ('Notify #1', 'EU', 'private', 'normal', 1, 10, false, true, null, now() + interval '1 day')
     returning id`,
  );
  await withTransaction((c) => seedTeamEconomy(c, res.rows[0].id, 'bosphorus'));
  return res.rows[0].id;
}

/** Ekonominin bit bazında değişmediğini kanıtlayan parmak izi. */
async function economyFingerprint(lobbyId: string): Promise<string> {
  const econ = await query(
    `select rp, factory_levels, car, upgrades_done from lobby_economy where lobby_id = $1 order by team_key`,
    [lobbyId],
  );
  const gold = await query(`select coalesce(sum(gold), 0) as g from users`);
  return JSON.stringify({ econ: econ.rows, gold: gold.rows });
}

describe('notify scheduler', () => {
  let lobbyId: string;
  before(async () => { await runMigrations(); });
  beforeEach(async () => { await query('delete from lobbies'); lobbyId = await makeLobby(); });
  after(async () => { await closePool(); });

  it('finds jobs that are ready and unclaimed', async () => {
    const job = await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'upgrade', payload: { label: 'MOTOR' } });
    const id = job.ok ? job.jobId : '';
    await query(`update pending_jobs set ends_at = now() - interval '1 minute' where id = $1`, [id]);

    const sent: string[] = [];
    const n = await sweepReadyJobs({ now: new Date(), send: async (j) => { sent.push(j.jobId); } });
    assert.equal(n, 1);
    assert.deepEqual(sent, [id]);
  });

  it('NEVER touches the economy', async () => {
    const job = await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'upgrade', payload: { label: 'MOTOR' } });
    await query(`update pending_jobs set ends_at = now() - interval '1 minute' where id = $1`, [job.ok ? job.jobId : '']);

    const before = await economyFingerprint(lobbyId);
    await sweepReadyJobs({ now: new Date(), send: async () => {} });
    await sweepReadyJobs({ now: new Date(), send: async () => {} });
    const after = await economyFingerprint(lobbyId);
    assert.equal(after, before, 'the notifier wrote to the economy');
  });

  it('notifies each job only once', async () => {
    const job = await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'upgrade', payload: { label: 'AERO' } });
    await query(`update pending_jobs set ends_at = now() - interval '1 minute' where id = $1`, [job.ok ? job.jobId : '']);

    const first = await sweepReadyJobs({ now: new Date(), send: async () => {} });
    const second = await sweepReadyJobs({ now: new Date(), send: async () => {} });
    assert.equal(first, 1);
    assert.equal(second, 0, 'the same job was notified twice');
  });

  it('two sweeps racing each other send at most one notification', async () => {
    const job = await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'upgrade', payload: { label: 'GRIP' } });
    await query(`update pending_jobs set ends_at = now() - interval '1 minute' where id = $1`, [job.ok ? job.jobId : '']);

    const sent: string[] = [];
    const [a, b] = await Promise.all([
      sweepReadyJobs({ now: new Date(), send: async (j) => { sent.push(j.jobId); } }),
      sweepReadyJobs({ now: new Date(), send: async (j) => { sent.push(j.jobId); } }),
    ]);
    assert.equal(a + b, 1);
    assert.equal(sent.length, 1);
  });

  it('ignores jobs that are not ready yet', async () => {
    await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'upgrade', payload: { label: 'MOTOR' } });
    assert.equal(await sweepReadyJobs({ now: new Date(), send: async () => {} }), 0);
  });

  it('ignores jobs that were already claimed', async () => {
    const job = await startJob({ lobbyId, teamKey: 'bosphorus', kind: 'upgrade', payload: { label: 'MOTOR' } });
    await query(
      `update pending_jobs set ends_at = now() - interval '1 minute', claimed_at = now() where id = $1`,
      [job.ok ? job.jobId : ''],
    );
    assert.equal(await sweepReadyJobs({ now: new Date(), send: async () => {} }), 0);
  });
});
```

- [ ] **Step 2: Testi koş, başarısız olduğunu gör**

- [ ] **Step 3: `server/src/notify/scheduler.ts` yaz**

```ts
/**
 * Biten işleri bulur ve bildirir. Spec §5.2.
 *
 * TEK KURAL: bu modül ekonomiye HİÇBİR ŞEY yazmaz. Yalnızca `notified_at`
 * damgalar. Bu yüzden iki kopya aynı anda koşsa en kötü ihtimalle bir bildirim
 * iki kez gider; kilitleme, birikmiş iş kuyruğu ve çifte uygulama koruması
 * gerekmez — uygulayacak bir şeyi yoktur.
 *
 * `for update skip locked` iki eşzamanlı taramanın aynı satırı almasını da
 * engeller, yani pratikte çift bildirim de olmaz.
 */
import { withTransaction } from '../db/pool.ts';

export interface ReadyJob {
  jobId: string;
  lobbyId: string;
  teamKey: string;
  kind: 'upgrade' | 'training' | 'spy';
  userId: string | null;
}

export interface SweepInput {
  now: Date;
  /** Bildirimi gönderen. Fırlatırsa o iş damgalanmaz ve sonraki taramada yeniden denenir. */
  send: (job: ReadyJob) => Promise<void>;
  limit?: number;
}

/** Bildirilen iş sayısını döner. */
export async function sweepReadyJobs(input: SweepInput): Promise<number> {
  const { now, send } = input;
  const limit = input.limit ?? 200;

  return withTransaction(async (client) => {
    const res = await client.query<{
      id: string; lobby_id: string; team_key: string;
      kind: ReadyJob['kind']; user_id: string | null;
    }>(
      `select j.id, j.lobby_id, j.team_key, j.kind, s.user_id
         from pending_jobs j
         left join lobby_seats s
           on s.lobby_id = j.lobby_id and s.team_key = j.team_key
        where j.claimed_at is null
          and j.notified_at is null
          and j.ends_at <= $1
        order by j.ends_at
        limit $2
        for update of j skip locked`,
      [now, limit],
    );

    let sent = 0;
    for (const row of res.rows) {
      const job: ReadyJob = {
        jobId: row.id,
        lobbyId: row.lobby_id,
        teamKey: row.team_key,
        kind: row.kind,
        userId: row.user_id,
      };
      // Koltuğu insan tutmuyorsa bildirilecek kimse yok; yine de damgala,
      // yoksa AI işleri her taramada yeniden bakılır.
      if (job.userId) await send(job);
      await client.query('update pending_jobs set notified_at = $2 where id = $1', [row.id, now]);
      sent += 1;
    }
    return sent;
  });
}
```

- [ ] **Step 4: Testi koş, geçtiğini gör**

Expected: PASS — 6 test

- [ ] **Step 5: Commit**

```bash
git add src/notify/scheduler.ts test/notify-scheduler.test.ts
git commit -m "feat(server): bildirim taraması — ekonomiye dokunmaz"
```

---

## Görev 15: Denge kapısı ve dokümantasyon

**Files:**
- Modify: `mobile/scripts/econ-check.ts` (`shared/`'ı hedefler), `mobile/package.json` ya da yeni `shared/scripts/econ-check.ts`
- Modify: `server/README.md`, `docs/FEATURES.md`
- Test: `server/test/economy-invariants.test.ts`

- [ ] **Step 1: `npm run econ`'u `shared/`'a yönlendir**

`mobile/scripts/econ-check.ts` bugün `@/data/...` import ediyor; `@pitwall/shared/...` olacak. Koş ve **geçtiğini** doğrula:

```bash
cd /Users/berkay/Documents/My-Projects/pit-wall/mobile && npm run econ 2>&1 | tail -20
```

65+ kontrolün hepsi geçmeli. Geçmiyorsa taşıma sırasında bir davranış değişmiş demektir — **kontrolü gevşetme**, neyin değiştiğini bul ve raporla.

- [ ] **Step 2: Sunucu ekonomisinin değişmezlerini test et**

`server/test/economy-invariants.test.ts` — spec §13'ün 3a-1 listesini kapsar:

1. Cihaz saati ileri alınmış istemci hiçbir şey kazanamaz (erken claim reddedilir).
2. Aynı claim iki kez etkisiz.
3. Aynı SSV callback'i / makbuz iki kez Altın yazamaz.
4. Günlük tavanlar sunucu gününe göre işler; istemci gün değiştirerek aşamaz.
5. Bildirim görevi iki kez koşturulduğunda ekonomi bit bazında aynı kalır.

Her biri için önce kuralı boz, testin düştüğünü gör, geri al ve **altı sonucun da öncesini/sonrasını raporla**.

- [ ] **Step 3: `server/README.md`'yi güncelle**

`## Kimlik` bölümünün altına `## Ekonomi` ekle, Türkçe:

- `POST /lobby/:id/action` eylem listesi ve durum kodları
- claim modeli: `ends_at` bir eşiktir, yazan tek şey claim, idempotent
- `serverNow`: istemci geri sayımı sunucu saatinden hesaplar
- `shared/` paketi: saf kalır, üretilen dosya değildir, `mobile` ve `server` ikisi de okur
- Altın muslukları: SSV ve makbuz doğrulaması, SKU beyaz listesi, günlük tavanlar UTC gününe göre
- **3a-1'in sınırı:** kazanç döngüsü kapanmadı; yarış ödülü 3a-2'de bağlanıyor

Ortam değişkenleri tablosuna ekle: `ADMOB_SSV_KEYS_URL` (isteğe bağlı, test tohumu), `APPLE_SHARED_SECRET`, `GOOGLE_PLAY_PACKAGE` ve Play servis hesabı kimlik bilgisi. Her biri için **eksikse ne olur** yaz: eksikse ilgili musluk **fail-closed** davranır, yani Altın yazmaz.

- [ ] **Step 4: `docs/FEATURES.md`'yi güncelle**

`## Lobi, koltuk ve slot` bölümünün altına `## Ekonomi (sunucu) — Faz 3a-1` ekle, dosyanın ✅/⬜ üslubuyla. Şunları ⬜ olarak işaretle: yarış muhasebesi, parc fermé/pit yolu, eski ligin kaldırılması (hepsi Faz 3a-2), istemcinin bağlanması (ayrı plan).

- [ ] **Step 5: Tam doğrulama**

```bash
cd /Users/berkay/Documents/My-Projects/pit-wall/shared && npm run typecheck
cd ../server && npm run typecheck && DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test npm test
cd ../mobile && npm run typecheck && npm run econ && npx expo export --platform ios 2>&1 | tail -3
```

- [ ] **Step 6: Commit**

```bash
cd /Users/berkay/Documents/My-Projects/pit-wall
git add server/README.md docs/FEATURES.md server/test/economy-invariants.test.ts mobile/scripts/econ-check.ts
git commit -m "test(server): ekonomi değişmezleri + Faz 3a-1 dokümantasyonu"
```

---

## Bitiş ölçütleri

- [ ] `shared/`, `server`, `mobile` — üç tip denetimi de temiz
- [ ] `npm test` (server) sıfır hata
- [ ] `npm run econ` geçiyor ve `shared/`'ı hedefliyor
- [ ] `npx expo export` hatasız — Metro `shared/`'ı gerçekten paketliyor
- [ ] Erken claim reddediliyor, çift claim etkisiz (bozup-düzelterek kanıtlanmış)
- [ ] Aynı SSV callback'i / makbuz iki kez Altın yazamıyor
- [ ] Günlük tavanlar UTC gününe göre
- [ ] Bildirim görevi ekonomiye hiçbir şey yazmıyor (parmak izi testi)
- [ ] Takım anahtarı istemciden değil koltuk satırından okunuyor
- [ ] Hiçbir log satırında imza, makbuz, e-posta veya istek gövdesi yok

## Sırada

**Faz 3a-1 istemci:** mobil store'un sunucudan okuması, salt-okunur önbellek, çevrimdışı şeridi, eylem çağrıları. Ayrı plan.

**Faz 3a-2:** lobi yarış koşucusu (veritabanı otoriteli periyodik tarama, `for update skip locked`), yarış muhasebesi, parc fermé/pit yolu başlangıcı, `Track.pitLaneSec`, eski ligin kaldırılması.
