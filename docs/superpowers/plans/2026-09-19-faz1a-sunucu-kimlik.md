# Faz 1a — Sunucu Tarafı Kimlik · Uygulama Planı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pit Wall sunucusuna Postgres destekli bir kimlik katmanı eklemek — sosyal ve şifreli giriş, çakışmasız `Nickname#1234` tahsisi, ülke ve region seçimi, profil uç noktaları.

**Architecture:** Mevcut `server/src/index.ts` (node:http + ws, tek lig) korunur; yanına `db/`, `auth/`, `identity/` modülleri ve küçük bir router eklenir. Saf mantık (nickname kuralları, şifre özeti, JWT, region eşlemesi, IP tablosu) DB'den bağımsız birimlerdir ve birim testleriyle sürülür; DB'ye dokunan kısımlar `TEST_DATABASE_URL`'e karşı entegrasyon testi alır. Ülke listesi ve IP→region tablosu **derleme zamanı üreteçleriyle** oluşturulur, çalışma anında hiçbir üçüncü tarafa istek gidilmez.

**Tech Stack:** Node 24 · TypeScript 5.9 · tsx · `node:test` (yerleşik koşucu) · Postgres (`pg`) · `jose` (JWKS + JWT) · `node:crypto` scrypt · CLDR (yalnızca üreteçte, devDependency)

**Spec:** [2026-09-19-cok-oyunculu-kabuk-tasarim.md](../specs/2026-09-19-cok-oyunculu-kabuk-tasarim.md) §2, §6, §7

---

## Kapsam

**Bu planda var:** Postgres şeması ve migration koşucusu · `users` + `auth_identities` · Google/Apple/Facebook token doğrulaması · e-posta+şifre · oturum JWT'si · nickname havuzu, doğrulama, öneri ve çakışmasız tahsisi · ülke listesi (endonim) üreteci · region kovaları ve yarış saatleri · IP→region çıkarımı (çevrimdışı, saklanmayan) · `/onboarding/bootstrap`, `/auth/*`, `/me` uç noktaları.

**Bu planda yok (Faz 1b ve sonrası):** Mobil onboarding ekranları · slot ve lobi tabloları · ekonominin sunucuya taşınması · arkadaşlık · mevcut `league.ts`'in parçalanması.

**Spec §2.5'te eksik kalan iki alan:** Profil yanıtı nickname, bayrak, rütbe puanı ve Altın'ı döndürür; **aktif oyun sayısı** ve **sezon arşivi** bu fazda yoktur çünkü `account_slots` ve `season_archive` tabloları Faz 2 ve Faz 4'te doğar. `publicProfile` o fazlarda genişletilir; bu planın testleri o alanların yokluğunu varsaymaz, sadece var olanları doğrular.

---

## Dosya yapısı

| Dosya | Sorumluluk |
|---|---|
| `server/src/db/pool.ts` | `pg` havuzu, tembel açılış, `query` yardımcısı |
| `server/src/db/migrate.ts` | Sıralı `.sql` migration koşucusu, `schema_migrations` |
| `server/src/db/migrations/001_identity.sql` | `users`, `auth_identities` |
| `server/src/identity/nicknamePool.ts` | 30 taban ad |
| `server/src/identity/profanity.ts` | Yasaklı kök listesi ve denetimi |
| `server/src/identity/nickname.ts` | Taban doğrulama, rastgele hane, öneri (saf) |
| `server/src/identity/nicknameRepo.ts` | Çakışmasız `(taban, hane)` tahsisi (DB) |
| `server/src/identity/countries.ts` | **ÜRETİLMİŞ** — ISO kodu + endonim ad + region |
| `server/src/identity/region.ts` | Region kovaları, yarış saatleri, ülke→region |
| `server/src/identity/ipRegion.ts` | `/16` tablosundan IP→region araması |
| `server/src/identity/ip-region-v4.bin` | **ÜRETİLMİŞ** — 65536 baytlık düz tablo |
| `server/src/identity/profileRepo.ts` | Profil okuma/güncelleme |
| `server/src/identity/routes.ts` | `/onboarding/bootstrap`, `GET/PATCH /me` |
| `server/src/auth/password.ts` | scrypt özet/doğrulama |
| `server/src/auth/jwt.ts` | Oturum JWT'si imzalama/doğrulama |
| `server/src/auth/emailHash.ts` | Biberli e-posta özeti |
| `server/src/auth/providers/google.ts` | Google ID token doğrulaması |
| `server/src/auth/providers/apple.ts` | Apple identity token doğrulaması |
| `server/src/auth/providers/facebook.ts` | Facebook access token doğrulaması |
| `server/src/auth/providers/index.ts` | Sağlayıcı kayıt defteri |
| `server/src/auth/userRepo.ts` | `users` + `auth_identities` SQL'leri |
| `server/src/auth/service.ts` | Kayıt/giriş/hesap birleştirme akışı |
| `server/src/auth/routes.ts` | `/auth/social`, `/auth/password/*` |
| `server/src/http/router.ts` | Yöntem+yol eşleyici, JSON gövde, CORS |
| `server/src/http/respond.ts` | `json()`, `fail()` yardımcıları |
| `server/src/http/clientIp.ts` | Güvenilir proxy'den istemci IP'si (asla saklanmaz) |
| `server/scripts/gen-countries.ts` | CLDR → `countries.ts` üreteci |
| `server/scripts/gen-ip-region.ts` | RIR delegation → `ip-region-v4.bin` üreteci |
| `server/test/*.test.ts` | Birim ve entegrasyon testleri |

---

## Görev 0: Test koşucusu, bağımlılıklar ve test veritabanı

**Files:**
- Modify: `server/package.json`
- Modify: `server/tsconfig.json`
- Create: `server/test/smoke.test.ts`
- Create: `server/.env.example`

- [ ] **Step 1: Bağımlılıkları kur**

```bash
cd server
npm install pg@^8.13.0 jose@^5.9.0
npm install --save-dev @types/pg@^8.11.0 cldr-localenames-full@^46.0.0 cldr-core@^46.0.0
```

- [ ] **Step 2: `server/package.json` scripts bloğunu değiştir**

Mevcut `"scripts"` bloğunu tamamen şununla değiştir:

```json
  "scripts": {
    "dev": "RACE_IN_SECONDS=20 CHECKIN_SECONDS=15 npx tsx watch src/index.ts",
    "start": "npx tsx src/index.ts",
    "typecheck": "tsc --noEmit -p .",
    "test": "node --import tsx --test \"test/**/*.test.ts\"",
    "migrate": "npx tsx src/db/migrate.ts",
    "gen:countries": "npx tsx scripts/gen-countries.ts",
    "gen:ip-region": "npx tsx scripts/gen-ip-region.ts"
  },
```

- [ ] **Step 3: `server/tsconfig.json` içinde `include` dizisini genişlet**

`"include"` dizisini şununla değiştir:

```json
  "include": [
    "src/**/*.ts",
    "test/**/*.ts",
    "scripts/**/*.ts",
    "../mobile/src/data/**/*.ts"
  ],
```

- [ ] **Step 4: `server/.env.example` oluştur**

```bash
# Postgres
DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall
TEST_DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test

# Oturum imzası — 32+ bayt rastgele. Üretimde Railway değişkeni olarak verilir.
SESSION_SECRET=change-me-32-bytes-minimum-secret

# E-posta özeti biberi — değişirse hesap birleştirme bozulur, ASLA döndürme.
EMAIL_HASH_PEPPER=change-me-too

# Sosyal giriş — virgülle ayrılmış birden çok değer kabul eder
GOOGLE_CLIENT_IDS=
APPLE_BUNDLE_IDS=
FACEBOOK_APP_ID=
FACEBOOK_APP_SECRET=
```

- [ ] **Step 5: Yerel Postgres'i başlat ve iki veritabanı oluştur**

> **Uygulama notu (2026-09-19):** Bu adım plan yazılırken Docker varsayıyordu.
> Geliştirme makinesinde Docker kapalıydı ve Homebrew'daki `postgresql@13`
> upstream'de EOL olduğu için (2026-03-01'de devre dışı bırakıldı) onarılamadı.
> Yerine `postgresql@17` kuruldu ve **5432** portunda çalışıyor. Tüm bağlantı
> dizeleri bu porta göredir.

```bash
brew install postgresql@17
brew services start postgresql@17

PSQL=/opt/homebrew/opt/postgresql@17/bin/psql
$PSQL -d postgres -c "CREATE ROLE pitwall LOGIN PASSWORD 'pitwall' CREATEDB"
$PSQL -d postgres -c "CREATE DATABASE pitwall OWNER pitwall"
$PSQL -d postgres -c "CREATE DATABASE pitwall_test OWNER pitwall"
```

Doğrulama:

```bash
PGPASSWORD=pitwall psql -h localhost -p 5432 -U pitwall -d pitwall_test \
  -tAc "select current_database(), current_user"
```

Beklenen çıktı: `pitwall_test|pitwall`

- [ ] **Step 6: Koşucunun ayakta olduğunu doğrulayan test yaz**

`server/test/smoke.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('test runner', () => {
  it('runs TypeScript test files', () => {
    assert.equal(1 + 1, 2);
  });
});
```

- [ ] **Step 7: Testi koş**

Run: `cd server && npm test`
Expected: PASS — `# pass 1`, `# fail 0`

- [ ] **Step 8: Commit**

```bash
cd server && git add package.json package-lock.json tsconfig.json test/smoke.test.ts .env.example
git commit -m "chore(server): node:test koşucusu, pg/jose bağımlılıkları, test veritabanı"
```

---

## Görev 1: Veritabanı havuzu

**Files:**
- Create: `server/src/db/pool.ts`
- Test: `server/test/db-pool.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

`server/test/db-pool.test.ts`:

```ts
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, getPool, closePool } from '../src/db/pool.ts';

describe('db pool', () => {
  after(async () => { await closePool(); });

  it('executes a query against the configured database', async () => {
    const res = await query<{ n: number }>('select 1::int as n');
    assert.equal(res.rows[0].n, 1);
  });

  it('reuses one pool across calls', () => {
    assert.equal(getPool(), getPool());
  });

  it('reports a clear error when DATABASE_URL is missing', async () => {
    const saved = process.env.DATABASE_URL;
    await closePool();            // açık havuzu düşür ki tembel açılış yeniden çalışsın
    delete process.env.DATABASE_URL;
    assert.throws(() => getPool(), /DATABASE_URL/);
    process.env.DATABASE_URL = saved;
  });
});
```

- [ ] **Step 2: Testi koş, başarısız olduğunu gör**

Run: `cd server && DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test npm test -- --test-name-pattern="db pool"`
Expected: FAIL — `Cannot find module '../src/db/pool.ts'`

- [ ] **Step 3: `server/src/db/pool.ts` yaz**

```ts
/**
 * Lazily-opened Postgres pool.
 *
 * Opening is deferred so that unit tests which never touch the database can
 * import modules in this tree without DATABASE_URL being set.
 */
import { Pool, type QueryResult, type QueryResultRow } from 'pg';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set — see server/.env.example');
  }
  pool = new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    // Railway'in yönetilen Postgres'i TLS ister ama sertifikayı kendi CA'sıyla
    // imzalar; yerelde TLS yok.
    ssl: /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString)
      ? undefined
      : { rejectUnauthorized: false },
  });
  return pool;
}

export function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: readonly unknown[],
): Promise<QueryResult<R>> {
  return getPool().query<R>(text, params as unknown[]);
}

/** Runs `fn` inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(
  fn: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}
```

- [ ] **Step 4: Testi koş, geçtiğini gör**

Run: `cd server && DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test npm test -- --test-name-pattern="db pool"`
Expected: PASS — `# pass 3`

- [ ] **Step 5: Commit**

```bash
cd server && git add src/db/pool.ts test/db-pool.test.ts
git commit -m "feat(server): tembel açılan Postgres havuzu ve işlem yardımcısı"
```

---

## Görev 2: Migration koşucusu ve kimlik şeması

**Files:**
- Create: `server/src/db/migrate.ts`
- Create: `server/src/db/migrations/001_identity.sql`
- Test: `server/test/migrate.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

`server/test/migrate.test.ts`:

```ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool } from '../src/db/pool.ts';

describe('migrations', () => {
  before(async () => {
    await query('drop table if exists auth_identities, users, schema_migrations cascade');
  });
  after(async () => { await closePool(); });

  it('creates the identity tables', async () => {
    await runMigrations();
    const res = await query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' order by table_name`,
    );
    const names = res.rows.map((r) => r.table_name);
    assert.ok(names.includes('users'), 'users table missing');
    assert.ok(names.includes('auth_identities'), 'auth_identities table missing');
  });

  it('is idempotent — running twice applies nothing new', async () => {
    const before = await query<{ count: string }>('select count(*) from schema_migrations');
    await runMigrations();
    const after = await query<{ count: string }>('select count(*) from schema_migrations');
    assert.equal(after.rows[0].count, before.rows[0].count);
  });

  it('enforces uniqueness on (nickname_base, nickname_tag)', async () => {
    await query(
      `insert into users (nickname_base, nickname_tag) values ('TurboKral', '0001')`,
    );
    await assert.rejects(
      () => query(`insert into users (nickname_base, nickname_tag) values ('TurboKral', '0001')`),
      /duplicate key/,
    );
    // Aynı taban, farklı hane serbest olmalı.
    await query(`insert into users (nickname_base, nickname_tag) values ('TurboKral', '0002')`);
    await query(`delete from users where nickname_base = 'TurboKral'`);
  });

  it('rejects an unknown region value', async () => {
    await assert.rejects(
      () => query(
        `insert into users (nickname_base, nickname_tag, region) values ('GridHunter', '0001', 'MARS')`,
      ),
      /users_region_check/,
    );
  });
});
```

- [ ] **Step 2: Testi koş, başarısız olduğunu gör**

Run: `cd server && DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test npm test -- --test-name-pattern="migrations"`
Expected: FAIL — `Cannot find module '../src/db/migrate.ts'`

- [ ] **Step 3: `server/src/db/migrations/001_identity.sql` yaz**

```sql
-- 001_identity.sql — hesap kimliği.
-- Spec: docs/superpowers/specs/2026-09-19-cok-oyunculu-kabuk-tasarim.md §2, §6

create extension if not exists pgcrypto;

create table if not exists users (
  id             uuid        primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  gold           integer     not null default 0,
  rank_points    integer     not null default 0,
  country_code   char(2),
  region         text,
  nickname_base  text        not null,
  nickname_tag   text        not null,

  constraint users_nickname_unique unique (nickname_base, nickname_tag),
  constraint users_region_check check (
    region is null or region in ('EU','NA','LATAM','MENA','APAC','SEA','OCE')
  ),
  constraint users_gold_check check (gold >= 0),
  -- Yalnızca rakam. Genişlik uygulamada zorlanır (varsayılan 4, dolunca artar);
  -- şema testlerin daralttığı genişlikleri de kabul edebilmek için serbesttir.
  constraint users_tag_check check (nickname_tag ~ '^[0-9]+$')
);

-- Aynı taban için boş hane taraması bu indeksi kullanır.
create index if not exists users_nickname_base_idx on users (nickname_base);

create table if not exists auth_identities (
  user_id       uuid        not null references users(id) on delete cascade,
  provider      text        not null,
  provider_uid  text        not null,
  email_hash    text,
  password_hash text,
  created_at    timestamptz not null default now(),

  primary key (provider, provider_uid),
  constraint auth_provider_check check (
    provider in ('google','apple','facebook','password')
  ),
  -- Şifre özeti yalnızca password sağlayıcısında olur, orada da zorunludur.
  constraint auth_password_hash_check check (
    (provider = 'password' and password_hash is not null)
    or (provider <> 'password' and password_hash is null)
  )
);

create index if not exists auth_identities_user_idx  on auth_identities (user_id);
-- Hesap birleştirme e-posta özetinden yapılır (ham e-posta saklanmaz).
create index if not exists auth_identities_email_idx on auth_identities (email_hash)
  where email_hash is not null;
```

- [ ] **Step 4: `server/src/db/migrate.ts` yaz**

```ts
/**
 * Sequential SQL migration runner.
 *
 * Every file in ./migrations is applied once, in filename order, each inside
 * its own transaction. Applied filenames are recorded in schema_migrations.
 *
 * Run standalone with: npm run migrate
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { getPool, closePool } from './pool.ts';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

export async function runMigrations(): Promise<string[]> {
  const pool = getPool();
  await pool.query(`
    create table if not exists schema_migrations (
      filename   text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const applied = new Set(
    (await pool.query<{ filename: string }>('select filename from schema_migrations'))
      .rows.map((r) => r.filename),
  );

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const freshlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (filename) values ($1)', [file]);
      await client.query('commit');
      freshlyApplied.push(file);
      console.log(`migrated: ${file}`);
    } catch (err) {
      await client.query('rollback');
      throw new Error(`migration failed: ${file}\n${String(err)}`, { cause: err });
    } finally {
      client.release();
    }
  }
  return freshlyApplied;
}

// Doğrudan çalıştırıldığında koş; import edildiğinde koşma.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then((f) => { console.log(f.length ? `${f.length} migration applied` : 'already up to date'); })
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => closePool());
}
```

- [ ] **Step 5: Testi koş, geçtiğini gör**

Run: `cd server && DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test npm test -- --test-name-pattern="migrations"`
Expected: PASS — `# pass 4`

- [ ] **Step 6: Geliştirme veritabanına da uygula**

Run: `cd server && DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall npm run migrate`
Expected: `migrated: 001_identity.sql` ve `1 migration applied`

- [ ] **Step 7: Commit**

```bash
cd server && git add src/db/migrate.ts src/db/migrations/001_identity.sql test/migrate.test.ts
git commit -m "feat(server): migration koşucusu ve kimlik şeması"
```

---

## Görev 3: Nickname kuralları (saf mantık)

**Files:**
- Create: `server/src/identity/nicknamePool.ts`
- Create: `server/src/identity/profanity.ts`
- Create: `server/src/identity/nickname.ts`
- Test: `server/test/nickname.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

`server/test/nickname.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  NICKNAME_POOL,
  validateBase,
  randomTag,
  suggestBases,
  formatNickname,
} from '../src/identity/nickname.ts';

describe('nickname pool', () => {
  it('holds exactly 30 distinct base names', () => {
    assert.equal(NICKNAME_POOL.length, 30);
    assert.equal(new Set(NICKNAME_POOL).size, 30);
  });

  it('every pooled name passes its own validator', () => {
    for (const base of NICKNAME_POOL) {
      assert.equal(validateBase(base), 'ok', `pooled name rejected: ${base}`);
    }
  });
});

describe('validateBase', () => {
  it('accepts non-Latin scripts and Turkish letters', () => {
    assert.equal(validateBase('ApexAvcısı'), 'ok');
    assert.equal(validateBase('ゴースト'), 'ok');
    assert.equal(validateBase('Şahin_07'), 'ok');
  });

  it('rejects names shorter than 3 characters', () => {
    assert.equal(validateBase('ab'), 'too_short');
  });

  it('rejects names longer than 16 characters', () => {
    assert.equal(validateBase('a'.repeat(17)), 'too_long');
  });

  it('rejects spaces, hashes and punctuation', () => {
    assert.equal(validateBase('Turbo Kral'), 'invalid_chars');
    assert.equal(validateBase('Turbo#01'), 'invalid_chars');
    assert.equal(validateBase('Turbo-Kral'), 'invalid_chars');
  });

  it('rejects blocked words regardless of case or digit substitution', () => {
    assert.equal(validateBase('adminPanel'), 'blocked');
    assert.equal(validateBase('PitWallOfficial'), 'blocked');
    assert.equal(validateBase('4dmin'), 'blocked');
  });
});

describe('randomTag', () => {
  it('produces a zero-padded tag of the requested width', () => {
    for (let i = 0; i < 200; i += 1) {
      const tag = randomTag(4);
      assert.match(tag, /^[0-9]{4}$/);
      assert.ok(Number(tag) >= 1 && Number(tag) <= 9999, `out of range: ${tag}`);
    }
  });

  it('never produces the all-zero tag', () => {
    for (let i = 0; i < 500; i += 1) assert.notEqual(randomTag(4), '0000');
  });

  it('supports a widened tag space', () => {
    const tag = randomTag(5);
    assert.match(tag, /^[0-9]{5}$/);
    assert.ok(Number(tag) >= 1 && Number(tag) <= 99999);
  });
});

describe('suggestBases', () => {
  it('returns the requested number of distinct pooled names', () => {
    const picks = suggestBases(4);
    assert.equal(picks.length, 4);
    assert.equal(new Set(picks).size, 4);
    for (const p of picks) assert.ok(NICKNAME_POOL.includes(p));
  });

  it('is deterministic when given a seeded rng', () => {
    const rng = () => 0.5;
    assert.deepEqual(suggestBases(3, rng), suggestBases(3, rng));
  });
});

describe('formatNickname', () => {
  it('joins base and tag with a hash', () => {
    assert.equal(formatNickname('TurboKral', '0417'), 'TurboKral#0417');
  });
});
```

- [ ] **Step 2: Testi koş, başarısız olduğunu gör**

Run: `cd server && npm test -- --test-name-pattern="nickname|validateBase|randomTag|suggestBases|formatNickname"`
Expected: FAIL — `Cannot find module '../src/identity/nickname.ts'`

- [ ] **Step 3: `server/src/identity/nicknamePool.ts` yaz**

```ts
/** Onboarding'de önerilen varsayılan taban adlar. Spec §2.2. */
export const NICKNAME_POOL = [
  'TurboKral',
  'ApexAvcısı',
  'PitStopUsta',
  'DriftBaron',
  'RedFlagRider',
  'ChequeredFlag',
  'SlipstreamKing',
  'GridHunter',
  'PolePositionX',
  'FastLapPro',
  'VelocityWolf',
  'RaceLineBey',
  'OverTakeMachine',
  'BoxBoxLegend',
  'HotLapHero',
  'CircuitGhost',
  'SafetyCarKral',
  'TurboNitro',
  'RaceCraftPro',
  'GripMaster',
  'DrsZone',
  'FinishLineX',
  'PaddockKing',
  'TarmacTiger',
  'CornerCutter',
  'FullThrottleX',
  'SpeedDemonTR',
  'LightsOutGo',
  'MidfieldWolf',
  'ChampionshipRun',
] as const satisfies readonly string[];
```

- [ ] **Step 4: `server/src/identity/profanity.ts` yaz**

```ts
/**
 * Blocked substrings for custom nickname bases.
 *
 * Two families:
 *   - impersonation: names that would let a player pose as staff or the brand
 *   - profanity: coarse roots in TR and EN
 *
 * Matching is done on a normalised form (lowercased, diacritics stripped,
 * common digit substitutions folded) so `4dmin` and `ADM1N` are caught too.
 * This is a seed list; extend it as reports come in.
 */
const BLOCKED_ROOTS = [
  // impersonation / reserved
  'admin', 'moderator', 'support', 'destek', 'yetkili', 'official', 'resmi',
  'pitwall', 'anthropic', 'system', 'sistem', 'staff', 'root', 'null',
  // profanity roots — TR
  'amk', 'orospu', 'pic', 'sikt', 'yarrak', 'gotver', 'ananı',
  // profanity roots — EN
  'fuck', 'shit', 'bitch', 'cunt', 'nigg', 'rape', 'nazi', 'hitler',
] as const;

const DIGIT_FOLD: Record<string, string> = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's',
};

/** Lowercase, strip diacritics, fold leetspeak digits, drop underscores. */
export function normaliseForModeration(input: string): string {
  const folded = input
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[_\s]/g, '');
  let out = '';
  for (const ch of folded) out += DIGIT_FOLD[ch] ?? ch;
  return out;
}

export function isBlocked(input: string): boolean {
  const normalised = normaliseForModeration(input);
  return BLOCKED_ROOTS.some((root) => normalised.includes(normaliseForModeration(root)));
}
```

- [ ] **Step 5: `server/src/identity/nickname.ts` yaz**

```ts
/**
 * Nickname rules — pure, database-free. Spec §2.2.
 *
 * A nickname is `base#tag`. Uniqueness lives on the PAIR, so TurboKral#0417
 * and TurboKral#8823 can both exist. Tags are random, never sequential: a
 * sequential tag would leak signup counts and account age.
 */
import { randomInt } from 'node:crypto';
import { NICKNAME_POOL } from './nicknamePool.ts';
import { isBlocked } from './profanity.ts';

export { NICKNAME_POOL };

export const BASE_MIN_LENGTH = 3;
export const BASE_MAX_LENGTH = 16;
export const DEFAULT_TAG_WIDTH = 4;

/** Letters (any script), digits and underscore. No spaces, no punctuation. */
const BASE_CHARS = /^[\p{L}\p{N}_]+$/u;

export type BaseValidation = 'ok' | 'too_short' | 'too_long' | 'invalid_chars' | 'blocked';

export function validateBase(base: string): BaseValidation {
  const length = [...base].length;
  if (length < BASE_MIN_LENGTH) return 'too_short';
  if (length > BASE_MAX_LENGTH) return 'too_long';
  if (!BASE_CHARS.test(base)) return 'invalid_chars';
  if (isBlocked(base)) return 'blocked';
  return 'ok';
}

/** Highest tag value for a given width: 9999 at width 4, 99999 at width 5. */
export function tagCeiling(width: number): number {
  return 10 ** width - 1;
}

/** A random tag in [1, ceiling], zero-padded to `width`. Never all zeroes. */
export function randomTag(width: number = DEFAULT_TAG_WIDTH): string {
  return String(randomInt(1, tagCeiling(width) + 1)).padStart(width, '0');
}

/** `count` distinct pooled base names. `rng` is injectable for tests. */
export function suggestBases(count: number, rng: () => number = Math.random): string[] {
  const remaining = [...NICKNAME_POOL];
  const picked: string[] = [];
  while (picked.length < count && remaining.length > 0) {
    const index = Math.min(remaining.length - 1, Math.floor(rng() * remaining.length));
    picked.push(remaining.splice(index, 1)[0]);
  }
  return picked;
}

export function formatNickname(base: string, tag: string): string {
  return `${base}#${tag}`;
}
```

- [ ] **Step 6: Testi koş, geçtiğini gör**

Run: `cd server && npm test -- --test-name-pattern="nickname|validateBase|randomTag|suggestBases|formatNickname"`
Expected: PASS — `# pass 14`

- [ ] **Step 7: Commit**

```bash
cd server && git add src/identity/nickname.ts src/identity/nicknamePool.ts src/identity/profanity.ts test/nickname.test.ts
git commit -m "feat(server): nickname kuralları, havuz ve moderasyon filtresi"
```

---

## Görev 4: Çakışmasız nickname tahsisi (DB)

**Files:**
- Create: `server/src/identity/nicknameRepo.ts`
- Test: `server/test/nickname-repo.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

`server/test/nickname-repo.test.ts`:

```ts
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool } from '../src/db/pool.ts';
import { allocateNickname, NicknameSpaceExhaustedError } from '../src/identity/nicknameRepo.ts';

describe('allocateNickname', () => {
  before(async () => { await runMigrations(); });
  beforeEach(async () => { await query('delete from users'); });
  after(async () => { await closePool(); });

  it('creates a user and returns the allocated pair', async () => {
    const allocated = await allocateNickname('TurboKral');
    assert.equal(allocated.base, 'TurboKral');
    assert.match(allocated.tag, /^[0-9]{4}$/);

    const row = await query<{ id: string }>('select id from users where id = $1', [allocated.userId]);
    assert.equal(row.rowCount, 1);
  });

  it('gives distinct tags to 60 concurrent allocations of the same base', async () => {
    const results = await Promise.all(
      Array.from({ length: 60 }, () => allocateNickname('GridHunter')),
    );
    const tags = results.map((r) => r.tag);
    assert.equal(new Set(tags).size, 60, 'duplicate tag allocated under concurrency');
  });

  it('widens the tag space once every tag of a width is taken', async () => {
    // Genişliği 1'e daraltarak tükenmeyi ucuza simüle et: '1'..'9' dolu.
    // Tahsis aynı genişlikteki haneleri taradığı için tagler tek haneli olmalı.
    for (let n = 1; n <= 9; n += 1) {
      await query('insert into users (nickname_base, nickname_tag) values ($1, $2)', [
        'DrsZone', String(n),
      ]);
    }
    const allocated = await allocateNickname('DrsZone', { width: 1, maxWidth: 2 });
    assert.equal(allocated.tag.length, 2, `expected a widened tag, got ${allocated.tag}`);
  });

  it('throws when the tag space cannot be widened any further', async () => {
    for (let n = 1; n <= 9; n += 1) {
      await query('insert into users (nickname_base, nickname_tag) values ($1, $2)', [
        'PaddockKing', String(n),
      ]);
    }
    await assert.rejects(
      () => allocateNickname('PaddockKing', { width: 1, maxWidth: 1 }),
      NicknameSpaceExhaustedError,
    );
  });

  it('rejects an invalid base before touching the database', async () => {
    await assert.rejects(() => allocateNickname('ab'), /too_short/);
    await assert.rejects(() => allocateNickname('adminPanel'), /blocked/);
  });
});
```

- [ ] **Step 2: Testi koş, başarısız olduğunu gör**

Run: `cd server && DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test npm test -- --test-name-pattern="allocateNickname"`
Expected: FAIL — `Cannot find module '../src/identity/nicknameRepo.ts'`

- [ ] **Step 3: `server/src/identity/nicknameRepo.ts` yaz**

```ts
/**
 * Race-free nickname allocation. Spec §2.2.
 *
 * Strategy, in order:
 *   1. Up to RANDOM_ATTEMPTS optimistic inserts with a random tag. The unique
 *      index on (nickname_base, nickname_tag) is the arbiter — ON CONFLICT DO
 *      NOTHING means a lost race costs one retry, never a duplicate.
 *   2. If those all collide, scan the base's taken tags and pick a free one at
 *      random from what remains (still via ON CONFLICT, so a concurrent writer
 *      taking it mid-scan just costs another loop).
 *   3. If the whole width is taken, widen the tag by one digit and start over.
 */
import type { PoolClient } from 'pg';
import { getPool } from '../db/pool.ts';
import { DEFAULT_TAG_WIDTH, randomTag, tagCeiling, validateBase } from './nickname.ts';

const RANDOM_ATTEMPTS = 8;
const DEFAULT_MAX_WIDTH = 8;

export class NicknameSpaceExhaustedError extends Error {
  constructor(base: string, maxWidth: number) {
    super(`nickname space exhausted for base "${base}" at width ${maxWidth}`);
    this.name = 'NicknameSpaceExhaustedError';
  }
}

export interface AllocatedNickname {
  userId: string;
  base: string;
  tag: string;
}

export interface AllocateOptions {
  /** Starting tag width. Defaults to 4. */
  width?: number;
  /** Widening stops here. Defaults to 8. */
  maxWidth?: number;
  /** Reuse an open transaction instead of the pool. */
  client?: PoolClient;
}

const INSERT_SQL = `
  insert into users (nickname_base, nickname_tag)
  values ($1, $2)
  on conflict (nickname_base, nickname_tag) do nothing
  returning id
`;

export async function allocateNickname(
  base: string,
  options: AllocateOptions = {},
): Promise<AllocatedNickname> {
  const verdict = validateBase(base);
  if (verdict !== 'ok') throw new Error(`invalid nickname base: ${verdict}`);

  const executor = options.client ?? getPool();
  const maxWidth = options.maxWidth ?? DEFAULT_MAX_WIDTH;
  let width = options.width ?? DEFAULT_TAG_WIDTH;

  const tryInsert = async (tag: string): Promise<string | null> => {
    const res = await executor.query<{ id: string }>(INSERT_SQL, [base, tag]);
    return res.rows[0]?.id ?? null;
  };

  while (width <= maxWidth) {
    for (let attempt = 0; attempt < RANDOM_ATTEMPTS; attempt += 1) {
      const tag = randomTag(width);
      const id = await tryInsert(tag);
      if (id) return { userId: id, base, tag };
    }

    // Yoğun taban: kalan boş haneleri tara.
    const taken = new Set(
      (await executor.query<{ nickname_tag: string }>(
        'select nickname_tag from users where nickname_base = $1 and length(nickname_tag) = $2',
        [base, width],
      )).rows.map((r) => r.nickname_tag),
    );

    const free: string[] = [];
    for (let n = 1; n <= tagCeiling(width); n += 1) {
      const tag = String(n).padStart(width, '0');
      if (!taken.has(tag)) free.push(tag);
    }

    // Boşları karıştırıp sırayla dene — eşzamanlı yazıcı birini kapsa sıradakine geçer.
    for (let i = free.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [free[i], free[j]] = [free[j], free[i]];
    }
    for (const tag of free) {
      const id = await tryInsert(tag);
      if (id) return { userId: id, base, tag };
    }

    width += 1;
  }

  throw new NicknameSpaceExhaustedError(base, maxWidth);
}
```

- [ ] **Step 4: Testi koş, geçtiğini gör**

Run: `cd server && DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test npm test -- --test-name-pattern="allocateNickname"`
Expected: PASS — `# pass 5`

- [ ] **Step 5: Commit**

```bash
cd server && git add src/identity/nicknameRepo.ts test/nickname-repo.test.ts
git commit -m "feat(server): eşzamanlılığa dayanıklı nickname tahsisi"
```

---

## Görev 5: Şifre özeti

**Files:**
- Create: `server/src/auth/password.ts`
- Test: `server/test/password.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

`server/test/password.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, validatePassword } from '../src/auth/password.ts';

describe('validatePassword', () => {
  it('accepts a password of at least 8 characters', () => {
    assert.equal(validatePassword('correct-horse'), 'ok');
  });

  it('rejects anything shorter than 8 characters', () => {
    assert.equal(validatePassword('short7!'), 'too_short');
  });

  it('rejects anything longer than 200 characters', () => {
    assert.equal(validatePassword('a'.repeat(201)), 'too_long');
  });
});

describe('hashPassword / verifyPassword', () => {
  it('round-trips a correct password', async () => {
    const stored = await hashPassword('correct-horse-battery');
    assert.equal(await verifyPassword('correct-horse-battery', stored), true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('correct-horse-battery');
    assert.equal(await verifyPassword('wrong-horse-battery', stored), false);
  });

  it('salts — the same password hashes differently every time', async () => {
    const a = await hashPassword('same-password-here');
    const b = await hashPassword('same-password-here');
    assert.notEqual(a, b);
  });

  it('emits the documented encoding', async () => {
    const stored = await hashPassword('correct-horse-battery');
    assert.match(stored, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  });

  it('returns false for a malformed stored value instead of throwing', async () => {
    assert.equal(await verifyPassword('anything', 'not-a-hash'), false);
    assert.equal(await verifyPassword('anything', 'scrypt$1$2$3'), false);
  });
});
```

- [ ] **Step 2: Testi koş, başarısız olduğunu gör**

Run: `cd server && npm test -- --test-name-pattern="Password|password"`
Expected: FAIL — `Cannot find module '../src/auth/password.ts'`

- [ ] **Step 3: `server/src/auth/password.ts` yaz**

```ts
/**
 * Password hashing with scrypt from node:crypto — no third-party dependency.
 *
 * Stored form: scrypt$<N>$<r>$<p>$<saltBase64>$<keyBase64>
 * The parameters live in the string so they can be raised later without
 * invalidating existing hashes.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MAXMEM = 64 * 1024 * 1024;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

export type PasswordValidation = 'ok' | 'too_short' | 'too_long';

export function validatePassword(password: string): PasswordValidation {
  if (password.length < PASSWORD_MIN_LENGTH) return 'too_short';
  if (password.length > PASSWORD_MAX_LENGTH) return 'too_long';
  return 'ok';
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await scrypt(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAXMEM });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const actual = await scrypt(password, salt, expected.length, { N: n, r, p, maxmem: MAXMEM });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Testi koş, geçtiğini gör**

Run: `cd server && npm test -- --test-name-pattern="Password|password"`
Expected: PASS — `# pass 9`

- [ ] **Step 5: Commit**

```bash
cd server && git add src/auth/password.ts test/password.test.ts
git commit -m "feat(server): scrypt ile şifre özeti ve doğrulaması"
```

---

## Görev 6: Oturum JWT'si ve e-posta özeti

**Files:**
- Create: `server/src/auth/jwt.ts`
- Create: `server/src/auth/emailHash.ts`
- Test: `server/test/jwt.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

`server/test/jwt.test.ts`:

```ts
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { signSession, verifySession, SESSION_TTL_SECONDS } from '../src/auth/jwt.ts';
import { hashEmail } from '../src/auth/emailHash.ts';

describe('session jwt', () => {
  before(() => {
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-32b';
  });

  it('round-trips a user id', async () => {
    const token = await signSession('11111111-2222-3333-4444-555555555555');
    assert.equal(await verifySession(token), '11111111-2222-3333-4444-555555555555');
  });

  it('returns null for a tampered token', async () => {
    const token = await signSession('11111111-2222-3333-4444-555555555555');
    const tampered = `${token.slice(0, -2)}xy`;
    assert.equal(await verifySession(tampered), null);
  });

  it('returns null for garbage instead of throwing', async () => {
    assert.equal(await verifySession('not.a.jwt'), null);
    assert.equal(await verifySession(''), null);
  });

  it('returns null for a token signed with a different secret', async () => {
    const token = await signSession('11111111-2222-3333-4444-555555555555');
    process.env.SESSION_SECRET = 'a-completely-different-secret-value';
    const result = await verifySession(token);
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-32b';
    assert.equal(result, null);
  });

  it('expires in 30 days', () => {
    assert.equal(SESSION_TTL_SECONDS, 30 * 24 * 60 * 60);
  });

  it('refuses to sign when SESSION_SECRET is absent', async () => {
    const saved = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    await assert.rejects(() => signSession('x'), /SESSION_SECRET/);
    process.env.SESSION_SECRET = saved;
  });
});

describe('hashEmail', () => {
  before(() => { process.env.EMAIL_HASH_PEPPER = 'test-pepper'; });

  it('is case- and whitespace-insensitive', () => {
    assert.equal(hashEmail('  Berkay@Example.COM '), hashEmail('berkay@example.com'));
  });

  it('produces different hashes for different addresses', () => {
    assert.notEqual(hashEmail('a@example.com'), hashEmail('b@example.com'));
  });

  it('is peppered — the hash changes with the pepper', () => {
    const a = hashEmail('berkay@example.com');
    process.env.EMAIL_HASH_PEPPER = 'different-pepper';
    const b = hashEmail('berkay@example.com');
    process.env.EMAIL_HASH_PEPPER = 'test-pepper';
    assert.notEqual(a, b);
  });

  it('does not contain the plaintext address', () => {
    assert.ok(!hashEmail('berkay@example.com').includes('berkay'));
  });
});
```

- [ ] **Step 2: Testi koş, başarısız olduğunu gör**

Run: `cd server && npm test -- --test-name-pattern="session jwt|hashEmail"`
Expected: FAIL — `Cannot find module '../src/auth/jwt.ts'`

- [ ] **Step 3: `server/src/auth/jwt.ts` yaz**

```ts
/** Our own session token. Provider tokens are verified then discarded. */
import { SignJWT, jwtVerify } from 'jose';

export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const ISSUER = 'pit-wall';
const AUDIENCE = 'pit-wall-app';

function secret(): Uint8Array {
  const raw = process.env.SESSION_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error('SESSION_SECRET is missing or shorter than 32 characters');
  }
  return new TextEncoder().encode(raw);
}

export async function signSession(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secret());
}

/** Returns the user id, or null if the token is absent, invalid or expired. */
export async function verifySession(token: string): Promise<string | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { issuer: ISSUER, audience: AUDIENCE });
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: `server/src/auth/emailHash.ts` yaz**

```ts
/**
 * We never store raw email addresses. Accounts are linked across providers by
 * a peppered SHA-256 of the normalised address.
 *
 * The pepper must never be rotated: rotating it orphans every existing link.
 */
import { createHmac } from 'node:crypto';

export function hashEmail(email: string): string {
  const pepper = process.env.EMAIL_HASH_PEPPER;
  if (!pepper) throw new Error('EMAIL_HASH_PEPPER is not set');
  const normalised = email.trim().toLowerCase();
  return createHmac('sha256', pepper).update(normalised).digest('base64url');
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isPlausibleEmail(email: string): boolean {
  return EMAIL_SHAPE.test(email.trim()) && email.trim().length <= 254;
}
```

- [ ] **Step 5: Testi koş, geçtiğini gör**

Run: `cd server && npm test -- --test-name-pattern="session jwt|hashEmail"`
Expected: PASS — `# pass 10`

- [ ] **Step 6: Commit**

```bash
cd server && git add src/auth/jwt.ts src/auth/emailHash.ts test/jwt.test.ts
git commit -m "feat(server): oturum JWT'si ve biberli e-posta özeti"
```

---

## Görev 7: Ülke listesi üreteci (endonim adlar)

**Files:**
- Create: `server/scripts/gen-countries.ts`
- Create: `server/src/identity/region.ts`
- Create: `server/src/identity/countries.ts` *(üretilmiş — elle düzenleme)*
- Test: `server/test/countries.test.ts`

- [ ] **Step 1: `server/src/identity/region.ts` yaz**

```ts
/**
 * Region buckets. Spec §2.4.
 *
 * A region is a matchmaking + race-hour bucket, NOT an identity. The player's
 * country is separate and purely cosmetic.
 */
export const REGIONS = ['EU', 'NA', 'LATAM', 'MENA', 'APAC', 'SEA', 'OCE'] as const;
export type Region = (typeof REGIONS)[number];

export function isRegion(value: unknown): value is Region {
  return typeof value === 'string' && (REGIONS as readonly string[]).includes(value);
}

/**
 * The daily race hour for each bucket, as an IANA zone plus a local hour.
 * Evening prime time in the bucket's most populous timezone.
 */
export const REGION_RACE_HOUR: Record<Region, { timeZone: string; hour: number }> = {
  EU:    { timeZone: 'Europe/Berlin',     hour: 21 },
  NA:    { timeZone: 'America/New_York',  hour: 21 },
  LATAM: { timeZone: 'America/Sao_Paulo', hour: 21 },
  MENA:  { timeZone: 'Asia/Dubai',        hour: 21 },
  APAC:  { timeZone: 'Asia/Tokyo',        hour: 21 },
  SEA:   { timeZone: 'Asia/Singapore',    hour: 21 },
  OCE:   { timeZone: 'Australia/Sydney',  hour: 20 },
};

/** Human-readable label for lobby names and the onboarding picker. */
export const REGION_LABEL: Record<Region, string> = {
  EU:    'Avrupa & Afrika',
  NA:    'Kuzey Amerika',
  LATAM: 'Latin Amerika',
  MENA:  'Orta Doğu & Kuzey Afrika',
  APAC:  'Asya-Pasifik',
  SEA:   'Güneydoğu Asya',
  OCE:   'Okyanusya',
};
```

- [ ] **Step 2: Başarısız testi yaz**

`server/test/countries.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COUNTRIES, countryByCode, isCountryCode } from '../src/identity/countries.ts';
import { REGIONS, isRegion, REGION_RACE_HOUR, REGION_LABEL } from '../src/identity/region.ts';

describe('region', () => {
  it('has seven buckets', () => {
    assert.equal(REGIONS.length, 7);
  });

  it('gives every bucket a race hour and a label', () => {
    for (const r of REGIONS) {
      assert.ok(REGION_RACE_HOUR[r], `no race hour for ${r}`);
      assert.ok(REGION_LABEL[r], `no label for ${r}`);
      assert.ok(REGION_RACE_HOUR[r].hour >= 0 && REGION_RACE_HOUR[r].hour <= 23);
      // Zaman dilimi adı geçerli olmalı — geçersizse Intl fırlatır.
      new Intl.DateTimeFormat('en', { timeZone: REGION_RACE_HOUR[r].timeZone });
    }
  });

  it('recognises only known buckets', () => {
    assert.equal(isRegion('EU'), true);
    assert.equal(isRegion('MARS'), false);
    assert.equal(isRegion(42), false);
  });
});

describe('countries', () => {
  it('covers at least 200 territories', () => {
    assert.ok(COUNTRIES.length >= 200, `only ${COUNTRIES.length} countries generated`);
  });

  it('uses two-letter uppercase ISO codes, each one only once', () => {
    const codes = COUNTRIES.map((c) => c.code);
    assert.equal(new Set(codes).size, codes.length);
    for (const code of codes) assert.match(code, /^[A-Z]{2}$/);
  });

  it('assigns every country to a valid region', () => {
    for (const c of COUNTRIES) {
      assert.ok(isRegion(c.region), `${c.code} has invalid region ${c.region}`);
    }
  });

  it('names countries in their own language, not in English', () => {
    assert.equal(countryByCode('TR')?.name, 'Türkiye');
    assert.equal(countryByCode('DE')?.name, 'Deutschland');
    assert.equal(countryByCode('ES')?.name, 'España');
    assert.equal(countryByCode('JP')?.name, '日本');
    assert.equal(countryByCode('GR')?.name, 'Ελλάδα');
    assert.equal(countryByCode('IT')?.name, 'Italia');
  });

  it('puts the obvious countries in the obvious buckets', () => {
    assert.equal(countryByCode('TR')?.region, 'MENA');
    assert.equal(countryByCode('DE')?.region, 'EU');
    assert.equal(countryByCode('US')?.region, 'NA');
    assert.equal(countryByCode('BR')?.region, 'LATAM');
    assert.equal(countryByCode('JP')?.region, 'APAC');
    assert.equal(countryByCode('ID')?.region, 'SEA');
    assert.equal(countryByCode('AU')?.region, 'OCE');
    assert.equal(countryByCode('EG')?.region, 'MENA');
    // Sahra altı Afrika'nın kendi kovası yok; saat dilimi olarak EU'ya düşer.
    assert.equal(countryByCode('NG')?.region, 'EU');
  });

  it('validates codes', () => {
    assert.equal(isCountryCode('TR'), true);
    assert.equal(isCountryCode('XX'), false);
    assert.equal(isCountryCode('tr'), false);
  });
});
```

- [ ] **Step 3: Testi koş, başarısız olduğunu gör**

Run: `cd server && npm test -- --test-name-pattern="region|countries"`
Expected: FAIL — `Cannot find module '../src/identity/countries.ts'`

- [ ] **Step 4: `server/scripts/gen-countries.ts` yaz**

```ts
/**
 * Generates src/identity/countries.ts from CLDR.
 *
 * Endonym: each territory is named in the language with the largest official
 * speaker population in that territory, per CLDR supplemental territoryInfo.
 *
 * Region: derived from CLDR territory containment, with two explicit overrides
 * (MENA and SEA are not CLDR containment groups as we want them). Sub-Saharan
 * Africa has no bucket of its own and falls into EU, which is the closest
 * match by timezone (UTC+0..+3).
 *
 * Run: npm run gen:countries
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { Region } from '../src/identity/region.ts';

const require = createRequire(import.meta.url);

const territoryInfo = require('cldr-core/supplemental/territoryInfo.json')
  .supplemental.territoryInfo as Record<string, {
    languagePopulation?: Record<string, {
      _populationPercent: string;
      _officialStatus?: string;
    }>;
  }>;

const containment = require('cldr-core/supplemental/territoryContainment.json')
  .supplemental.territoryContainment as Record<string, { _contains: string[] }>;

/** ISO 3166-1 alpha-2 codes only: two letters, no UN M49 numeric groups. */
const isCountry = (code: string) => /^[A-Z]{2}$/.test(code);

/** Every leaf country under a UN M49 group code. */
function leaves(group: string): string[] {
  const node = containment[group];
  if (!node) return isCountry(group) ? [group] : [];
  return node._contains.flatMap((child) => (isCountry(child) ? [child] : leaves(child)));
}

const MENA = new Set([
  'DZ', 'BH', 'EG', 'IR', 'IQ', 'IL', 'JO', 'KW', 'LB', 'LY', 'MA', 'OM', 'PS',
  'QA', 'SA', 'SY', 'TN', 'TR', 'AE', 'YE', 'EH', 'SD', 'MR',
]);

const SEA = new Set([
  'BN', 'KH', 'ID', 'LA', 'MY', 'MM', 'PH', 'SG', 'TH', 'TL', 'VN',
]);

function regionFor(code: string, sets: Record<string, Set<string>>): Region {
  if (MENA.has(code)) return 'MENA';
  if (SEA.has(code)) return 'SEA';
  if (sets.northernAmerica.has(code)) return 'NA';
  if (sets.latinAmerica.has(code)) return 'LATAM';
  if (sets.oceania.has(code)) return 'OCE';
  if (sets.asia.has(code)) return 'APAC';
  // Avrupa ve (kovası olmayan) Afrika — ikisi de EU saatine düşer.
  return 'EU';
}

/** The language with the largest official-speaker share in a territory. */
function endonymLocale(code: string): string | null {
  const pop = territoryInfo[code]?.languagePopulation;
  if (!pop) return null;
  const ranked = Object.entries(pop)
    .filter(([, v]) => v._officialStatus === 'official' || v._officialStatus === 'de_facto_official')
    .sort((a, b) => Number(b[1]._populationPercent) - Number(a[1]._populationPercent));
  return ranked[0]?.[0] ?? null;
}

/** CLDR locale folder for a language tag, walking down to the bare language. */
function territoriesFor(locale: string): Record<string, string> | null {
  const candidates = [locale, locale.split('_')[0], locale.split('-')[0]];
  for (const candidate of candidates) {
    try {
      const json = require(`cldr-localenames-full/main/${candidate}/territories.json`);
      return json.main[candidate].localeDisplayNames.territories as Record<string, string>;
    } catch {
      /* bu adayda yok, sıradakine geç */
    }
  }
  return null;
}

async function main(): Promise<void> {
  const sets = {
    northernAmerica: new Set(leaves('021')),
    latinAmerica:    new Set(leaves('419')),
    oceania:         new Set(leaves('009')),
    asia:            new Set(leaves('142')),
  };

  const english = territoriesFor('en');
  if (!english) throw new Error('cldr-localenames-full: en/territories.json not found');

  const rows: { code: string; name: string; region: Region }[] = [];
  const fallbacks: string[] = [];

  for (const code of Object.keys(territoryInfo).filter(isCountry).sort()) {
    const locale = endonymLocale(code);
    const names = locale ? territoriesFor(locale) : null;
    const name = names?.[code] ?? english[code];
    if (!name) continue;
    if (!names?.[code]) fallbacks.push(code);
    rows.push({ code, name, region: regionFor(code, sets) });
  }

  const body = rows
    .map((r) => `  { code: '${r.code}', name: ${JSON.stringify(r.name)}, region: '${r.region}' },`)
    .join('\n');

  const source = `/**
 * GENERATED by scripts/gen-countries.ts — do not edit by hand.
 * Regenerate with: npm run gen:countries
 *
 * Names are endonyms (each territory in its own primary official language) and
 * are deliberately NOT localised: a player from Japan sees 日本 in every
 * language build of the app.
 */
import type { Region } from './region.ts';

export interface Country {
  readonly code: string;
  readonly name: string;
  readonly region: Region;
}

export const COUNTRIES: readonly Country[] = [
${body}
];

const BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c]));

export function countryByCode(code: string): Country | undefined {
  return BY_CODE.get(code);
}

export function isCountryCode(code: unknown): code is string {
  return typeof code === 'string' && BY_CODE.has(code);
}
`;

  const out = fileURLToPath(new URL('../src/identity/countries.ts', import.meta.url));
  await writeFile(out, source, 'utf8');
  console.log(`wrote ${rows.length} countries to ${out}`);
  if (fallbacks.length) {
    console.log(`fell back to English for ${fallbacks.length}: ${fallbacks.join(', ')}`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
```

- [ ] **Step 5: Üreteci çalıştır**

Run: `cd server && npm run gen:countries`
Expected: `wrote 2xx countries to .../src/identity/countries.ts` (sayı 200'ün üstünde)

- [ ] **Step 6: Testi koş, geçtiğini gör**

Run: `cd server && npm test -- --test-name-pattern="region|countries"`
Expected: PASS — `# pass 9`

> Bir ad beklenenden farklı çıkarsa, `gen-countries.ts` içindeki `endonymLocale`
> o ülke için başka bir dil seçmiş demektir. Üretilmiş dosyayı **elle düzeltme** —
> üretece o ülke için açık bir dil ataması ekle ve yeniden üret.

- [ ] **Step 7: Commit**

```bash
cd server && git add scripts/gen-countries.ts src/identity/region.ts src/identity/countries.ts test/countries.test.ts package.json package-lock.json
git commit -m "feat(server): region kovaları ve CLDR'den üretilen endonim ülke listesi"
```

---

## Görev 8: IP → region çıkarımı

**Files:**
- Create: `server/scripts/gen-ip-region.ts`
- Create: `server/src/identity/ipRegion.ts`
- Create: `server/src/identity/ip-region-v4.bin` *(üretilmiş, 65536 bayt)*
- Create: `server/src/http/clientIp.ts`
- Test: `server/test/ip-region.test.ts`

**Neden bu tasarım:** Region yalnızca bir **öneridir**; oyuncu onaylar. Doğruluk kıta düzeyinde yeterli olduğu için tablo `/16` çözünürlüğünde tutulur — ilk iki oktet doğrudan 65536 baytlık düz bir dizide indekstir, arama O(1) ve dosya 64 KB'dir. Veri kaynağı RIR delegation dosyalarıdır (kamu malı); çalışma anında hiçbir üçüncü tarafa istek gitmez, hiçbir IP saklanmaz. IPv6 için tablo yoktur; `null` döner ve oyuncuya öneri sunulmaz.

- [ ] **Step 1: Başarısız testi yaz**

`server/test/ip-region.test.ts`:

```ts
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
    // Google DNS (US) ve Türk Telekom aralığı — ikisi de bilinir olmalı.
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
```

- [ ] **Step 2: Testi koş, başarısız olduğunu gör**

Run: `cd server && npm test -- --test-name-pattern="regionForIp|clientIpOf"`
Expected: FAIL — `Cannot find module '../src/identity/ipRegion.ts'`

- [ ] **Step 3: `server/scripts/gen-ip-region.ts` yaz**

```ts
/**
 * Generates src/identity/ip-region-v4.bin — a flat 65536-byte table where the
 * index is the first two octets of an IPv4 address and the value is a region
 * index (0 = unknown, 1..7 = REGIONS[n-1]).
 *
 * Source: the five RIR "delegated-extended" files, which are public domain and
 * map IPv4 blocks to country codes. Each /16 is assigned to whichever region
 * owns the most addresses inside it.
 *
 * Run: npm run gen:ip-region   (needs network; run manually, not in CI)
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { REGIONS, type Region } from '../src/identity/region.ts';
import { countryByCode } from '../src/identity/countries.ts';

const SOURCES = [
  'https://ftp.ripe.net/pub/stats/ripencc/delegated-ripencc-extended-latest',
  'https://ftp.arin.net/pub/stats/arin/delegated-arin-extended-latest',
  'https://ftp.apnic.net/stats/apnic/delegated-apnic-extended-latest',
  'https://ftp.lacnic.net/pub/stats/lacnic/delegated-lacnic-extended-latest',
  'https://ftp.afrinic.net/pub/stats/afrinic/delegated-afrinic-extended-latest',
];

const TABLE_SIZE = 65536;
const regionIndex = new Map<Region, number>(REGIONS.map((r, i) => [r, i + 1]));

/** Per /16 block, how many addresses each region owns. */
const tally = Array.from({ length: TABLE_SIZE }, () => new Map<number, number>());

function ipToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

function record(start: number, count: number, region: number): void {
  const end = start + count - 1;
  const firstBlock = Math.floor(start / 65536);
  const lastBlock = Math.floor(end / 65536);
  for (let block = firstBlock; block <= lastBlock && block < TABLE_SIZE; block += 1) {
    const blockStart = block * 65536;
    const overlap = Math.min(end, blockStart + 65535) - Math.max(start, blockStart) + 1;
    const bucket = tally[block];
    bucket.set(region, (bucket.get(region) ?? 0) + overlap);
  }
}

async function ingest(url: string): Promise<number> {
  console.log(`fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const text = await res.text();

  let rows = 0;
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    // registry|cc|type|start|value|date|status|...
    const f = line.split('|');
    if (f.length < 7 || f[2] !== 'ipv4') continue;
    if (f[6] !== 'allocated' && f[6] !== 'assigned') continue;

    const country = countryByCode(f[1]);
    if (!country) continue;
    const region = regionIndex.get(country.region);
    if (!region) continue;

    const start = ipToInt(f[3]);
    const count = Number(f[4]);
    if (start === null || !Number.isInteger(count) || count <= 0) continue;

    record(start, count, region);
    rows += 1;
  }
  return rows;
}

async function main(): Promise<void> {
  let total = 0;
  for (const url of SOURCES) total += await ingest(url);
  console.log(`ingested ${total} ipv4 records`);

  const table = new Uint8Array(TABLE_SIZE);
  let known = 0;
  for (let block = 0; block < TABLE_SIZE; block += 1) {
    let best = 0;
    let bestCount = 0;
    for (const [region, count] of tally[block]) {
      if (count > bestCount) { best = region; bestCount = count; }
    }
    table[block] = best;
    if (best !== 0) known += 1;
  }

  const out = fileURLToPath(new URL('../src/identity/ip-region-v4.bin', import.meta.url));
  await writeFile(out, table);
  const coverage = ((known / TABLE_SIZE) * 100).toFixed(1);
  console.log(`wrote ${TABLE_SIZE} bytes to ${out} — ${coverage}% of /16 blocks classified`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
```

- [ ] **Step 4: `server/src/identity/ipRegion.ts` yaz**

```ts
/**
 * Offline IPv4 → region lookup. Spec §2.4.
 *
 * The table is a flat 65536-byte array indexed by the first two octets, loaded
 * once at boot. No network call, no third party, and the address itself is
 * never stored or logged — the caller uses the answer as a SUGGESTION which
 * the player then confirms.
 *
 * IPv6 is unsupported on purpose: we return null and the client simply shows
 * no pre-selected region.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REGIONS, type Region } from './region.ts';

const TABLE = readFileSync(fileURLToPath(new URL('./ip-region-v4.bin', import.meta.url)));

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isReservedV4(a: number, b: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true;             // this-network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true;             // CGNAT
  if (a === 169 && b === 254) return true;                       // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;              // private
  if (a === 192 && b === 168) return true;                       // private
  if (a >= 224) return true;                                     // multicast + reserved
  return false;
}

/** The region a public IPv4 address most likely sits in, or null. */
export function regionForIp(ip: string): Region | null {
  const match = IPV4.exec(ip.trim());
  if (!match) return null;

  const a = Number(match[1]);
  const b = Number(match[2]);
  const c = Number(match[3]);
  const d = Number(match[4]);
  if ([a, b, c, d].some((n) => n > 255)) return null;
  if (isReservedV4(a, b)) return null;

  const value = TABLE[(a << 8) | b];
  if (!value || value > REGIONS.length) return null;
  return REGIONS[value - 1];
}
```

- [ ] **Step 5: `server/src/http/clientIp.ts` yaz**

```ts
/**
 * Extracts the client address from a request.
 *
 * PRIVACY CONTRACT (spec §2.4): the returned value is passed straight to
 * regionForIp() and then dropped. It must never be written to a table, a log
 * line, an error message or an analytics event.
 */
export function clientIpOf(
  headers: Record<string, string | string[] | undefined>,
  socketAddress: string | undefined,
): string {
  const forwarded = headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const candidate = raw ? raw.split(',')[0]!.trim() : (socketAddress ?? '');
  return candidate.startsWith('::ffff:') ? candidate.slice('::ffff:'.length) : candidate;
}
```

- [ ] **Step 6: Tabloyu üret**

Run: `cd server && npm run gen:ip-region`
Expected: `wrote 65536 bytes to .../ip-region-v4.bin — 5x.x% of /16 blocks classified`

- [ ] **Step 7: Testi koş, geçtiğini gör**

Run: `cd server && npm test -- --test-name-pattern="regionForIp|clientIpOf"`
Expected: PASS — `# pass 10`

- [ ] **Step 8: Commit**

```bash
cd server && git add scripts/gen-ip-region.ts src/identity/ipRegion.ts src/identity/ip-region-v4.bin src/http/clientIp.ts test/ip-region.test.ts package.json
git commit -m "feat(server): çevrimdışı IP→region çıkarımı, hiçbir adres saklanmaz"
```

---

## Görev 9: Kullanıcı deposu

**Files:**
- Create: `server/src/auth/userRepo.ts`
- Test: `server/test/user-repo.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

`server/test/user-repo.test.ts`:

```ts
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool } from '../src/db/pool.ts';
import {
  createUserWithIdentity,
  findUserByProviderUid,
  findUserByEmailHash,
  addIdentity,
  loadUser,
  updateProfile,
} from '../src/auth/userRepo.ts';

describe('userRepo', () => {
  before(async () => { await runMigrations(); });
  beforeEach(async () => { await query('delete from users'); });
  after(async () => { await closePool(); });

  it('creates a user together with its first identity', async () => {
    const user = await createUserWithIdentity({
      base: 'TurboKral',
      provider: 'google',
      providerUid: 'google-uid-1',
      emailHash: 'hash-1',
    });
    assert.equal(user.nicknameBase, 'TurboKral');
    assert.match(user.nicknameTag, /^[0-9]{4}$/);
    assert.equal(user.gold, 0);
    assert.equal(user.rankPoints, 0);
    assert.equal(user.countryCode, null);
    assert.equal(user.region, null);
  });

  it('finds a user by provider uid', async () => {
    const created = await createUserWithIdentity({
      base: 'GridHunter', provider: 'apple', providerUid: 'apple-uid-1', emailHash: null,
    });
    const found = await findUserByProviderUid('apple', 'apple-uid-1');
    assert.equal(found?.id, created.id);
    assert.equal(await findUserByProviderUid('apple', 'nope'), null);
  });

  it('finds a user by email hash for cross-provider linking', async () => {
    const created = await createUserWithIdentity({
      base: 'DrsZone', provider: 'google', providerUid: 'g-2', emailHash: 'shared-hash',
    });
    const found = await findUserByEmailHash('shared-hash');
    assert.equal(found?.id, created.id);
  });

  it('links a second provider to an existing user', async () => {
    const created = await createUserWithIdentity({
      base: 'HotLapHero', provider: 'google', providerUid: 'g-3', emailHash: 'shared-2',
    });
    await addIdentity(created.id, { provider: 'facebook', providerUid: 'fb-3', emailHash: 'shared-2' });
    const viaFacebook = await findUserByProviderUid('facebook', 'fb-3');
    assert.equal(viaFacebook?.id, created.id);
  });

  it('rolls back the user when the identity insert conflicts', async () => {
    await createUserWithIdentity({
      base: 'BoxBoxLegend', provider: 'google', providerUid: 'dup-uid', emailHash: null,
    });
    await assert.rejects(() => createUserWithIdentity({
      base: 'CircuitGhost', provider: 'google', providerUid: 'dup-uid', emailHash: null,
    }));
    const leftovers = await query('select 1 from users where nickname_base = $1', ['CircuitGhost']);
    assert.equal(leftovers.rowCount, 0, 'orphaned user row left behind');
  });

  it('stores a password hash only for the password provider', async () => {
    const user = await createUserWithIdentity({
      base: 'GripMaster', provider: 'password', providerUid: 'email-hash-9',
      emailHash: 'email-hash-9', passwordHash: 'scrypt$16384$8$1$c2FsdA==$a2V5',
    });
    const row = await query<{ password_hash: string }>(
      'select password_hash from auth_identities where user_id = $1', [user.id],
    );
    assert.equal(row.rows[0].password_hash, 'scrypt$16384$8$1$c2FsdA==$a2V5');
  });

  it('updates country and region, leaving other fields untouched', async () => {
    const user = await createUserWithIdentity({
      base: 'TarmacTiger', provider: 'google', providerUid: 'g-4', emailHash: null,
    });
    const updated = await updateProfile(user.id, { countryCode: 'TR', region: 'MENA' });
    assert.equal(updated?.countryCode, 'TR');
    assert.equal(updated?.region, 'MENA');
    assert.equal(updated?.nicknameBase, 'TarmacTiger');
  });

  it('loads a user by id and returns null for an unknown id', async () => {
    const user = await createUserWithIdentity({
      base: 'MidfieldWolf', provider: 'google', providerUid: 'g-5', emailHash: null,
    });
    assert.equal((await loadUser(user.id))?.id, user.id);
    assert.equal(await loadUser('00000000-0000-0000-0000-000000000000'), null);
  });
});
```

- [ ] **Step 2: Testi koş, başarısız olduğunu gör**

Run: `cd server && DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test npm test -- --test-name-pattern="userRepo"`
Expected: FAIL — `Cannot find module '../src/auth/userRepo.ts'`

- [ ] **Step 3: `server/src/auth/userRepo.ts` yaz**

```ts
/** SQL for users and auth_identities. Spec §6. */
import { query, withTransaction } from '../db/pool.ts';
import { allocateNickname } from '../identity/nicknameRepo.ts';
import type { Region } from '../identity/region.ts';

export type Provider = 'google' | 'apple' | 'facebook' | 'password';

export interface User {
  id: string;
  createdAt: Date;
  gold: number;
  rankPoints: number;
  countryCode: string | null;
  region: Region | null;
  nicknameBase: string;
  nicknameTag: string;
}

interface UserRow {
  id: string;
  created_at: Date;
  gold: number;
  rank_points: number;
  country_code: string | null;
  region: Region | null;
  nickname_base: string;
  nickname_tag: string;
}

const SELECT_USER = `
  select id, created_at, gold, rank_points, country_code, region, nickname_base, nickname_tag
    from users
`;

function toUser(row: UserRow): User {
  return {
    id: row.id,
    createdAt: row.created_at,
    gold: row.gold,
    rankPoints: row.rank_points,
    countryCode: row.country_code,
    region: row.region,
    nicknameBase: row.nickname_base,
    nicknameTag: row.nickname_tag,
  };
}

export interface IdentityInput {
  provider: Provider;
  providerUid: string;
  emailHash: string | null;
  passwordHash?: string | null;
}

export interface CreateUserInput extends IdentityInput {
  base: string;
  countryCode?: string | null;
  region?: Region | null;
}

const INSERT_IDENTITY = `
  insert into auth_identities (user_id, provider, provider_uid, email_hash, password_hash)
  values ($1, $2, $3, $4, $5)
`;

export async function createUserWithIdentity(input: CreateUserInput): Promise<User> {
  return withTransaction(async (client) => {
    const allocated = await allocateNickname(input.base, { client });
    await client.query(INSERT_IDENTITY, [
      allocated.userId,
      input.provider,
      input.providerUid,
      input.emailHash,
      input.passwordHash ?? null,
    ]);
    if (input.countryCode || input.region) {
      await client.query(
        'update users set country_code = $2, region = $3 where id = $1',
        [allocated.userId, input.countryCode ?? null, input.region ?? null],
      );
    }
    const res = await client.query<UserRow>(`${SELECT_USER} where id = $1`, [allocated.userId]);
    return toUser(res.rows[0]);
  });
}

export async function addIdentity(userId: string, identity: IdentityInput): Promise<void> {
  await query(INSERT_IDENTITY, [
    userId, identity.provider, identity.providerUid,
    identity.emailHash, identity.passwordHash ?? null,
  ]);
}

export async function findUserByProviderUid(
  provider: Provider,
  providerUid: string,
): Promise<User | null> {
  const res = await query<UserRow>(
    `${SELECT_USER}
      where id = (select user_id from auth_identities where provider = $1 and provider_uid = $2)`,
    [provider, providerUid],
  );
  return res.rows[0] ? toUser(res.rows[0]) : null;
}

export async function findUserByEmailHash(emailHash: string): Promise<User | null> {
  const res = await query<UserRow>(
    `${SELECT_USER}
      where id = (select user_id from auth_identities
                   where email_hash = $1 order by created_at limit 1)`,
    [emailHash],
  );
  return res.rows[0] ? toUser(res.rows[0]) : null;
}

/** The stored password hash for an email, or null if there is no such login. */
export async function findPasswordHash(emailHash: string): Promise<{ userId: string; hash: string } | null> {
  const res = await query<{ user_id: string; password_hash: string }>(
    `select user_id, password_hash from auth_identities
      where provider = 'password' and provider_uid = $1`,
    [emailHash],
  );
  const row = res.rows[0];
  return row?.password_hash ? { userId: row.user_id, hash: row.password_hash } : null;
}

export async function loadUser(userId: string): Promise<User | null> {
  const res = await query<UserRow>(`${SELECT_USER} where id = $1`, [userId]);
  return res.rows[0] ? toUser(res.rows[0]) : null;
}

export interface ProfilePatch {
  countryCode?: string;
  region?: Region;
}

export async function updateProfile(userId: string, patch: ProfilePatch): Promise<User | null> {
  const res = await query<UserRow>(
    `update users
        set country_code = coalesce($2, country_code),
            region       = coalesce($3, region)
      where id = $1
      returning id, created_at, gold, rank_points, country_code, region, nickname_base, nickname_tag`,
    [userId, patch.countryCode ?? null, patch.region ?? null],
  );
  return res.rows[0] ? toUser(res.rows[0]) : null;
}
```

- [ ] **Step 4: Testi koş, geçtiğini gör**

Run: `cd server && DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test npm test -- --test-name-pattern="userRepo"`
Expected: PASS — `# pass 8`

- [ ] **Step 5: Commit**

```bash
cd server && git add src/auth/userRepo.ts test/user-repo.test.ts
git commit -m "feat(server): kullanıcı ve kimlik deposu"
```

---

## Görev 10: Sosyal sağlayıcı doğrulaması

**Files:**
- Create: `server/src/auth/providers/google.ts`
- Create: `server/src/auth/providers/apple.ts`
- Create: `server/src/auth/providers/facebook.ts`
- Create: `server/src/auth/providers/index.ts`
- Test: `server/test/providers.test.ts`

**Not:** Testler gerçek Google/Apple/Facebook'a bağlanmaz. JWKS tabanlı sağlayıcılar için test kendi anahtar çiftini üretip yerel bir JWKS uç noktası servis eder; Facebook için `fetch` geçici olarak değiştirilir.

- [ ] **Step 1: Başarısız testi yaz**

`server/test/providers.test.ts`:

```ts
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { SignJWT, exportJWK, generateKeyPair, type KeyLike } from 'jose';
import { verifyGoogleToken, __setGoogleJwksUrl } from '../src/auth/providers/google.ts';
import { verifyFacebookToken } from '../src/auth/providers/facebook.ts';

let jwks: Server;
let privateKey: KeyLike;
let jwksUrl: string;

async function issue(claims: Record<string, unknown>, opts: { iss: string; aud: string; exp?: string }) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(opts.iss)
    .setAudience(opts.aud)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(privateKey);
}

describe('verifyGoogleToken', () => {
  before(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
    jwks = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((r) => jwks.listen(0, r));
    const port = (jwks.address() as { port: number }).port;
    jwksUrl = `http://127.0.0.1:${port}/certs`;
    __setGoogleJwksUrl(jwksUrl);
    process.env.GOOGLE_CLIENT_IDS = 'client-a.apps.googleusercontent.com,client-b.apps.googleusercontent.com';
  });

  after(async () => { await new Promise<void>((r) => jwks.close(() => r())); });

  it('accepts a token from a configured client id', async () => {
    const token = await issue({ sub: 'google-123', email: 'a@example.com', email_verified: true },
      { iss: 'https://accounts.google.com', aud: 'client-a.apps.googleusercontent.com' });
    const result = await verifyGoogleToken(token);
    assert.deepEqual(result, { providerUid: 'google-123', email: 'a@example.com' });
  });

  it('accepts the second configured client id too', async () => {
    const token = await issue({ sub: 'google-456' },
      { iss: 'https://accounts.google.com', aud: 'client-b.apps.googleusercontent.com' });
    assert.equal((await verifyGoogleToken(token))?.providerUid, 'google-456');
  });

  it('rejects an unconfigured audience', async () => {
    const token = await issue({ sub: 'google-789' },
      { iss: 'https://accounts.google.com', aud: 'someone-elses-client-id' });
    assert.equal(await verifyGoogleToken(token), null);
  });

  it('rejects a wrong issuer', async () => {
    const token = await issue({ sub: 'google-999' },
      { iss: 'https://evil.example.com', aud: 'client-a.apps.googleusercontent.com' });
    assert.equal(await verifyGoogleToken(token), null);
  });

  it('rejects an expired token', async () => {
    const token = await issue({ sub: 'google-000' },
      { iss: 'https://accounts.google.com', aud: 'client-a.apps.googleusercontent.com', exp: '-1s' });
    assert.equal(await verifyGoogleToken(token), null);
  });

  it('drops an unverified email rather than trusting it', async () => {
    const token = await issue({ sub: 'google-111', email: 'spoof@example.com', email_verified: false },
      { iss: 'https://accounts.google.com', aud: 'client-a.apps.googleusercontent.com' });
    assert.deepEqual(await verifyGoogleToken(token), { providerUid: 'google-111', email: null });
  });

  it('rejects garbage', async () => {
    assert.equal(await verifyGoogleToken('not-a-token'), null);
  });
});

describe('verifyFacebookToken', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.FACEBOOK_APP_ID = 'app-1';
    process.env.FACEBOOK_APP_SECRET = 'secret-1';
  });
  after(() => { globalThis.fetch = realFetch; });

  const stub = (routes: Record<string, unknown>) => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      const key = Object.keys(routes).find((k) => url.includes(k));
      if (!key) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(routes[key]), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
  };

  it('accepts a valid token issued for our app', async () => {
    stub({
      'debug_token': { data: { is_valid: true, app_id: 'app-1', user_id: 'fb-1' } },
      '/me': { id: 'fb-1', email: 'fb@example.com' },
    });
    assert.deepEqual(await verifyFacebookToken('tok'), { providerUid: 'fb-1', email: 'fb@example.com' });
  });

  it('rejects a token issued for a different app', async () => {
    stub({ 'debug_token': { data: { is_valid: true, app_id: 'someone-else', user_id: 'fb-2' } } });
    assert.equal(await verifyFacebookToken('tok'), null);
  });

  it('rejects an invalid token', async () => {
    stub({ 'debug_token': { data: { is_valid: false, app_id: 'app-1' } } });
    assert.equal(await verifyFacebookToken('tok'), null);
  });

  it('succeeds with a null email when Facebook returns none', async () => {
    stub({
      'debug_token': { data: { is_valid: true, app_id: 'app-1', user_id: 'fb-3' } },
      '/me': { id: 'fb-3' },
    });
    assert.deepEqual(await verifyFacebookToken('tok'), { providerUid: 'fb-3', email: null });
  });
});
```

- [ ] **Step 2: Testi koş, başarısız olduğunu gör**

Run: `cd server && npm test -- --test-name-pattern="verifyGoogleToken|verifyFacebookToken"`
Expected: FAIL — `Cannot find module '../src/auth/providers/google.ts'`

- [ ] **Step 3: `server/src/auth/providers/google.ts` yaz**

```ts
/** Google ID token verification against Google's published JWKS. */
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { VerifiedIdentity } from './index.ts';

let jwksUrl = 'https://www.googleapis.com/oauth2/v3/certs';
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/** Test seam: points the verifier at a local JWKS server. */
export function __setGoogleJwksUrl(url: string): void {
  jwksUrl = url;
  jwks = null;
}

function keySet() {
  jwks ??= createRemoteJWKSet(new URL(jwksUrl));
  return jwks;
}

function audiences(): string[] {
  return (process.env.GOOGLE_CLIENT_IDS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

export async function verifyGoogleToken(token: string): Promise<VerifiedIdentity | null> {
  const aud = audiences();
  if (aud.length === 0) return null;
  try {
    const { payload } = await jwtVerify(token, keySet(), {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: aud,
    });
    if (typeof payload.sub !== 'string') return null;
    const email = payload.email_verified === true && typeof payload.email === 'string'
      ? payload.email
      : null;
    return { providerUid: payload.sub, email };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: `server/src/auth/providers/apple.ts` yaz**

```ts
/**
 * Apple identity token verification.
 *
 * Apple only returns the email on the very first authorisation, and it may be
 * a private relay address — either way we just hash whatever we are given.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { VerifiedIdentity } from './index.ts';

let jwksUrl = 'https://appleid.apple.com/auth/keys';
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/** Test seam: points the verifier at a local JWKS server. */
export function __setAppleJwksUrl(url: string): void {
  jwksUrl = url;
  jwks = null;
}

function keySet() {
  jwks ??= createRemoteJWKSet(new URL(jwksUrl));
  return jwks;
}

function audiences(): string[] {
  return (process.env.APPLE_BUNDLE_IDS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

export async function verifyAppleToken(token: string): Promise<VerifiedIdentity | null> {
  const aud = audiences();
  if (aud.length === 0) return null;
  try {
    const { payload } = await jwtVerify(token, keySet(), {
      issuer: 'https://appleid.apple.com',
      audience: aud,
    });
    if (typeof payload.sub !== 'string') return null;
    // Apple, email_verified'ı string ("true") ya da boolean olarak gönderebilir.
    const verified = payload.email_verified === true || payload.email_verified === 'true';
    const email = verified && typeof payload.email === 'string' ? payload.email : null;
    return { providerUid: payload.sub, email };
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: `server/src/auth/providers/facebook.ts` yaz**

```ts
/**
 * Facebook access token verification.
 *
 * Facebook has no JWKS; the token is checked with the Graph debug_token
 * endpoint using an app access token. The app_id check is what stops a token
 * minted for a different app from being replayed against us.
 */
import type { VerifiedIdentity } from './index.ts';

const GRAPH = 'https://graph.facebook.com/v21.0';

interface DebugTokenResponse {
  data?: { is_valid?: boolean; app_id?: string; user_id?: string };
}

export async function verifyFacebookToken(token: string): Promise<VerifiedIdentity | null> {
  const appId = process.env.FACEBOOK_APP_ID;
  const appSecret = process.env.FACEBOOK_APP_SECRET;
  if (!appId || !appSecret) return null;

  try {
    const debugUrl = `${GRAPH}/debug_token?input_token=${encodeURIComponent(token)}`
      + `&access_token=${encodeURIComponent(`${appId}|${appSecret}`)}`;
    const debugRes = await fetch(debugUrl);
    if (!debugRes.ok) return null;

    const debug = (await debugRes.json()) as DebugTokenResponse;
    const data = debug.data;
    if (!data?.is_valid || data.app_id !== appId || !data.user_id) return null;

    const meUrl = `${GRAPH}/me?fields=id,email&access_token=${encodeURIComponent(token)}`;
    const meRes = await fetch(meUrl);
    const me = meRes.ok ? ((await meRes.json()) as { id?: string; email?: string }) : {};

    return { providerUid: data.user_id, email: me.email ?? null };
  } catch {
    return null;
  }
}
```

- [ ] **Step 6: `server/src/auth/providers/index.ts` yaz**

```ts
/** Social provider registry. Spec §2.1. */
import { verifyGoogleToken } from './google.ts';
import { verifyAppleToken } from './apple.ts';
import { verifyFacebookToken } from './facebook.ts';

export interface VerifiedIdentity {
  providerUid: string;
  /** Verified address, or null when the provider gave none we can trust. */
  email: string | null;
}

export type SocialProvider = 'google' | 'apple' | 'facebook';

const VERIFIERS: Record<SocialProvider, (token: string) => Promise<VerifiedIdentity | null>> = {
  google: verifyGoogleToken,
  apple: verifyAppleToken,
  facebook: verifyFacebookToken,
};

export function isSocialProvider(value: unknown): value is SocialProvider {
  return value === 'google' || value === 'apple' || value === 'facebook';
}

export function verifySocialToken(
  provider: SocialProvider,
  token: string,
): Promise<VerifiedIdentity | null> {
  return VERIFIERS[provider](token);
}
```

- [ ] **Step 7: Testi koş, geçtiğini gör**

Run: `cd server && npm test -- --test-name-pattern="verifyGoogleToken|verifyFacebookToken"`
Expected: PASS — `# pass 11`

- [ ] **Step 8: Commit**

```bash
cd server && git add src/auth/providers test/providers.test.ts
git commit -m "feat(server): Google, Apple ve Facebook token doğrulaması"
```

---

## Görev 11: Kimlik servisi

**Files:**
- Create: `server/src/auth/service.ts`
- Test: `server/test/auth-service.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

`server/test/auth-service.test.ts`:

```ts
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool } from '../src/db/pool.ts';
import { verifySession } from '../src/auth/jwt.ts';
import { hashEmail } from '../src/auth/emailHash.ts';
import {
  authenticateSocial,
  registerWithPassword,
  loginWithPassword,
  AuthError,
} from '../src/auth/service.ts';

// Sağlayıcı doğrulayıcısını sahte bir uygulamayla değiştir — ağ yok.
const fakeVerify = (map: Record<string, { providerUid: string; email: string | null }>) =>
  async (_provider: string, token: string) => map[token] ?? null;

describe('authenticateSocial', () => {
  before(async () => {
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-32b';
    process.env.EMAIL_HASH_PEPPER = 'test-pepper';
    await runMigrations();
  });
  beforeEach(async () => { await query('delete from users'); });
  after(async () => { await closePool(); });

  it('creates a new account on first sign-in and returns a usable session', async () => {
    const out = await authenticateSocial(
      { provider: 'google', token: 'tok-1', nicknameBase: 'TurboKral', countryCode: 'TR', region: 'MENA' },
      { verify: fakeVerify({ 'tok-1': { providerUid: 'g-1', email: 'a@example.com' } }) },
    );
    assert.equal(out.isNew, true);
    assert.equal(out.user.nicknameBase, 'TurboKral');
    assert.equal(out.user.countryCode, 'TR');
    assert.equal(out.user.region, 'MENA');
    assert.equal(await verifySession(out.token), out.user.id);
  });

  it('returns the same account on a second sign-in', async () => {
    const verify = fakeVerify({ 'tok-1': { providerUid: 'g-1', email: 'a@example.com' } });
    const first = await authenticateSocial({ provider: 'google', token: 'tok-1' }, { verify });
    const second = await authenticateSocial({ provider: 'google', token: 'tok-1' }, { verify });
    assert.equal(second.isNew, false);
    assert.equal(second.user.id, first.user.id);
  });

  it('links a second provider that shares a verified email', async () => {
    const google = await authenticateSocial(
      { provider: 'google', token: 'g' },
      { verify: fakeVerify({ g: { providerUid: 'g-9', email: 'same@example.com' } }) },
    );
    const apple = await authenticateSocial(
      { provider: 'apple', token: 'a' },
      { verify: fakeVerify({ a: { providerUid: 'a-9', email: 'same@example.com' } }) },
    );
    assert.equal(apple.user.id, google.user.id, 'accounts were not linked');
    assert.equal(apple.isNew, false);
  });

  it('does NOT link when the email is absent', async () => {
    const one = await authenticateSocial(
      { provider: 'google', token: 'g' },
      { verify: fakeVerify({ g: { providerUid: 'g-8', email: null } }) },
    );
    const two = await authenticateSocial(
      { provider: 'apple', token: 'a' },
      { verify: fakeVerify({ a: { providerUid: 'a-8', email: null } }) },
    );
    assert.notEqual(two.user.id, one.user.id);
  });

  it('picks a pooled nickname when none is supplied', async () => {
    const out = await authenticateSocial(
      { provider: 'google', token: 'g' },
      { verify: fakeVerify({ g: { providerUid: 'g-7', email: null } }) },
    );
    assert.match(out.user.nicknameTag, /^[0-9]{4}$/);
    assert.equal(out.user.nicknameBase.length > 0, true);
  });

  it('rejects an invalid provider token', async () => {
    await assert.rejects(
      () => authenticateSocial({ provider: 'google', token: 'bad' }, { verify: fakeVerify({}) }),
      (e: AuthError) => e.code === 'invalid_token',
    );
  });

  it('rejects a blocked nickname base', async () => {
    await assert.rejects(
      () => authenticateSocial(
        { provider: 'google', token: 'g', nicknameBase: 'adminPanel' },
        { verify: fakeVerify({ g: { providerUid: 'g-6', email: null } }) },
      ),
      (e: AuthError) => e.code === 'nickname_blocked',
    );
  });

  it('rejects an unknown country code', async () => {
    await assert.rejects(
      () => authenticateSocial(
        { provider: 'google', token: 'g', countryCode: 'XX' },
        { verify: fakeVerify({ g: { providerUid: 'g-5', email: null } }) },
      ),
      (e: AuthError) => e.code === 'invalid_country',
    );
  });
});

describe('password auth', () => {
  before(async () => {
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-32b';
    process.env.EMAIL_HASH_PEPPER = 'test-pepper';
    await runMigrations();
  });
  beforeEach(async () => { await query('delete from users'); });
  after(async () => { await closePool(); });

  it('registers and then logs in', async () => {
    const reg = await registerWithPassword({
      email: 'berkay@example.com', password: 'correct-horse', nicknameBase: 'GridHunter',
    });
    assert.equal(reg.isNew, true);
    const login = await loginWithPassword({ email: 'berkay@example.com', password: 'correct-horse' });
    assert.equal(login.user.id, reg.user.id);
  });

  it('treats the email case-insensitively', async () => {
    await registerWithPassword({ email: 'berkay@example.com', password: 'correct-horse' });
    const login = await loginWithPassword({ email: '  BERKAY@Example.com ', password: 'correct-horse' });
    assert.ok(login.user.id);
  });

  it('never stores the raw address', async () => {
    await registerWithPassword({ email: 'berkay@example.com', password: 'correct-horse' });
    const rows = await query<{ email_hash: string; provider_uid: string }>(
      'select email_hash, provider_uid from auth_identities',
    );
    for (const row of rows.rows) {
      assert.ok(!row.email_hash.includes('berkay'), 'raw email leaked into email_hash');
      assert.ok(!row.provider_uid.includes('berkay'), 'raw email leaked into provider_uid');
    }
    assert.equal(rows.rows[0].email_hash, hashEmail('berkay@example.com'));
  });

  it('rejects a duplicate registration', async () => {
    await registerWithPassword({ email: 'berkay@example.com', password: 'correct-horse' });
    await assert.rejects(
      () => registerWithPassword({ email: 'berkay@example.com', password: 'another-password' }),
      (e: AuthError) => e.code === 'email_taken',
    );
  });

  it('rejects a wrong password with the same error as an unknown account', async () => {
    await registerWithPassword({ email: 'berkay@example.com', password: 'correct-horse' });
    const wrong = await loginWithPassword({ email: 'berkay@example.com', password: 'nope-nope-nope' })
      .then(() => null, (e: AuthError) => e.code);
    const unknown = await loginWithPassword({ email: 'nobody@example.com', password: 'nope-nope-nope' })
      .then(() => null, (e: AuthError) => e.code);
    assert.equal(wrong, 'invalid_credentials');
    assert.equal(unknown, 'invalid_credentials');
  });

  it('rejects a malformed email and a short password', async () => {
    await assert.rejects(
      () => registerWithPassword({ email: 'not-an-email', password: 'correct-horse' }),
      (e: AuthError) => e.code === 'invalid_email',
    );
    await assert.rejects(
      () => registerWithPassword({ email: 'a@example.com', password: 'short' }),
      (e: AuthError) => e.code === 'password_too_short',
    );
  });
});
```

- [ ] **Step 2: Testi koş, başarısız olduğunu gör**

Run: `cd server && DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test npm test -- --test-name-pattern="authenticateSocial|password auth"`
Expected: FAIL — `Cannot find module '../src/auth/service.ts'`

- [ ] **Step 3: `server/src/auth/service.ts` yaz**

```ts
/**
 * Sign-up / sign-in flow. Spec §2.1.
 *
 * Account linking rule: two providers land on the same account only when both
 * handed us a VERIFIED email address. Linking on an unverified address would
 * let anyone who can claim an address take over the account behind it.
 */
import { signSession } from './jwt.ts';
import { hashEmail, isPlausibleEmail } from './emailHash.ts';
import { hashPassword, validatePassword, verifyPassword } from './password.ts';
import { isSocialProvider, verifySocialToken, type SocialProvider, type VerifiedIdentity } from './providers/index.ts';
import {
  addIdentity, createUserWithIdentity, findPasswordHash,
  findUserByEmailHash, findUserByProviderUid, type User,
} from './userRepo.ts';
import { suggestBases, validateBase } from '../identity/nickname.ts';
import { isCountryCode } from '../identity/countries.ts';
import { isRegion, type Region } from '../identity/region.ts';

export type AuthErrorCode =
  | 'invalid_provider' | 'invalid_token' | 'invalid_email' | 'email_taken'
  | 'invalid_credentials' | 'password_too_short' | 'password_too_long'
  | 'nickname_too_short' | 'nickname_too_long' | 'nickname_invalid_chars'
  | 'nickname_blocked' | 'invalid_country' | 'invalid_region';

export class AuthError extends Error {
  constructor(readonly code: AuthErrorCode) {
    super(code);
    this.name = 'AuthError';
  }
}

export interface AuthResult {
  user: User;
  token: string;
  isNew: boolean;
}

interface OnboardingFields {
  nicknameBase?: string;
  countryCode?: string;
  region?: string;
}

/** Validates the optional onboarding fields, throwing on the first problem. */
function checkOnboarding(fields: OnboardingFields): {
  base: string; countryCode: string | null; region: Region | null;
} {
  const base = fields.nicknameBase ?? suggestBases(1)[0];
  const verdict = validateBase(base);
  if (verdict !== 'ok') throw new AuthError(`nickname_${verdict}` as AuthErrorCode);

  if (fields.countryCode !== undefined && !isCountryCode(fields.countryCode)) {
    throw new AuthError('invalid_country');
  }
  if (fields.region !== undefined && !isRegion(fields.region)) {
    throw new AuthError('invalid_region');
  }
  return {
    base,
    countryCode: fields.countryCode ?? null,
    region: (fields.region as Region | undefined) ?? null,
  };
}

async function issue(user: User, isNew: boolean): Promise<AuthResult> {
  return { user, token: await signSession(user.id), isNew };
}

export interface SocialInput extends OnboardingFields {
  provider: string;
  token: string;
}

export interface SocialDeps {
  /** Injectable so tests never reach the real providers. */
  verify?: (provider: SocialProvider, token: string) => Promise<VerifiedIdentity | null>;
}

export async function authenticateSocial(
  input: SocialInput,
  deps: SocialDeps = {},
): Promise<AuthResult> {
  if (!isSocialProvider(input.provider)) throw new AuthError('invalid_provider');
  const verify = deps.verify ?? verifySocialToken;

  const identity = await verify(input.provider, input.token);
  if (!identity) throw new AuthError('invalid_token');

  // 1. Bu sağlayıcı kimliği daha önce görüldü mü?
  const existing = await findUserByProviderUid(input.provider, identity.providerUid);
  if (existing) return issue(existing, false);

  const emailHash = identity.email ? hashEmail(identity.email) : null;

  // 2. Doğrulanmış e-posta başka bir hesaba bağlıysa, oraya ekle.
  if (emailHash) {
    const linked = await findUserByEmailHash(emailHash);
    if (linked) {
      await addIdentity(linked.id, {
        provider: input.provider, providerUid: identity.providerUid, emailHash,
      });
      return issue(linked, false);
    }
  }

  // 3. Yeni hesap.
  const onboarding = checkOnboarding(input);
  const user = await createUserWithIdentity({
    base: onboarding.base,
    provider: input.provider,
    providerUid: identity.providerUid,
    emailHash,
    countryCode: onboarding.countryCode,
    region: onboarding.region,
  });
  return issue(user, true);
}

export interface PasswordRegisterInput extends OnboardingFields {
  email: string;
  password: string;
}

export async function registerWithPassword(input: PasswordRegisterInput): Promise<AuthResult> {
  if (!isPlausibleEmail(input.email)) throw new AuthError('invalid_email');
  const pwVerdict = validatePassword(input.password);
  if (pwVerdict !== 'ok') throw new AuthError(`password_${pwVerdict}` as AuthErrorCode);

  const onboarding = checkOnboarding(input);
  const emailHash = hashEmail(input.email);

  if (await findUserByProviderUid('password', emailHash)) throw new AuthError('email_taken');

  const passwordHash = await hashPassword(input.password);

  // Aynı e-posta sosyal bir hesapta varsa, şifre girişini ona ekle.
  const linked = await findUserByEmailHash(emailHash);
  if (linked) {
    await addIdentity(linked.id, {
      provider: 'password', providerUid: emailHash, emailHash, passwordHash,
    });
    return issue(linked, false);
  }

  const user = await createUserWithIdentity({
    base: onboarding.base,
    provider: 'password',
    providerUid: emailHash,
    emailHash,
    passwordHash,
    countryCode: onboarding.countryCode,
    region: onboarding.region,
  });
  return issue(user, true);
}

export interface PasswordLoginInput {
  email: string;
  password: string;
}

export async function loginWithPassword(input: PasswordLoginInput): Promise<AuthResult> {
  if (!isPlausibleEmail(input.email)) throw new AuthError('invalid_credentials');
  const emailHash = hashEmail(input.email);

  const stored = await findPasswordHash(emailHash);
  if (!stored) {
    // Bilinmeyen hesapta da scrypt maliyetini öde — cevap süresi hesabın var
    // olup olmadığını sızdırmasın.
    await hashPassword(input.password);
    throw new AuthError('invalid_credentials');
  }
  if (!(await verifyPassword(input.password, stored.hash))) {
    throw new AuthError('invalid_credentials');
  }

  const user = await findUserByProviderUid('password', emailHash);
  if (!user) throw new AuthError('invalid_credentials');
  return issue(user, false);
}
```

- [ ] **Step 4: Testi koş, geçtiğini gör**

Run: `cd server && DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test npm test -- --test-name-pattern="authenticateSocial|password auth"`
Expected: PASS — `# pass 14`

- [ ] **Step 5: Commit**

```bash
cd server && git add src/auth/service.ts test/auth-service.test.ts
git commit -m "feat(server): kayıt, giriş ve sağlayıcılar arası hesap birleştirme"
```

---

## Görev 12: HTTP yönlendirici ve yanıt yardımcıları

**Files:**
- Create: `server/src/http/respond.ts`
- Create: `server/src/http/router.ts`
- Test: `server/test/router.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

`server/test/router.test.ts`:

```ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Router } from '../src/http/router.ts';

let server: Server;
let base: string;

describe('Router', () => {
  before(async () => {
    const router = new Router();
    router.get('/ping', async () => ({ status: 200, body: { pong: true } }));
    router.post('/echo', async (ctx) => ({ status: 200, body: { got: ctx.body } }));
    router.get('/boom', async () => { throw new Error('kaboom'); });

    server = createServer(async (req, res) => {
      if (await router.handle(req, res)) return;
      res.writeHead(404).end('fell through');
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it('routes a GET and returns JSON', async () => {
    const res = await fetch(`${base}/ping`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.deepEqual(await res.json(), { pong: true });
  });

  it('parses a JSON body on POST', async () => {
    const res = await fetch(`${base}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    });
    assert.deepEqual(await res.json(), { got: { a: 1 } });
  });

  it('answers a malformed JSON body with 400, not a crash', async () => {
    const res = await fetch(`${base}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json() as { error: string }).error, 'invalid_json');
  });

  it('turns an unexpected throw into a 500 without leaking the message', async () => {
    const res = await fetch(`${base}/boom`);
    assert.equal(res.status, 500);
    const body = await res.json() as { error: string };
    assert.equal(body.error, 'internal_error');
    assert.ok(!JSON.stringify(body).includes('kaboom'), 'internal message leaked to client');
  });

  it('answers CORS preflight', async () => {
    const res = await fetch(`${base}/echo`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.ok(res.headers.get('access-control-allow-headers')?.includes('authorization'));
  });

  it('returns false for an unregistered route so the caller can fall through', async () => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), 'fell through');
  });

  it('rejects a body larger than the limit', async () => {
    const res = await fetch(`${base}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(200_000) }),
    });
    assert.equal(res.status, 413);
  });
});
```

- [ ] **Step 2: Testi koş, başarısız olduğunu gör**

Run: `cd server && npm test -- --test-name-pattern="Router"`
Expected: FAIL — `Cannot find module '../src/http/router.ts'`

- [ ] **Step 3: `server/src/http/respond.ts` yaz**

```ts
import type { ServerResponse } from 'node:http';

export const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type,authorization',
  'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
} as const;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...CORS_HEADERS,
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, status: number, code: string): void {
  sendJson(res, status, { error: code });
}
```

- [ ] **Step 4: `server/src/http/router.ts` yaz**

```ts
/**
 * A deliberately small method+path router for node:http.
 *
 * `handle` returns false when nothing matched, so the existing league
 * endpoints in index.ts keep working untouched.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError, sendJson, CORS_HEADERS } from './respond.ts';

const MAX_BODY_BYTES = 64 * 1024;

export interface RequestContext {
  req: IncomingMessage;
  url: URL;
  body: Record<string, unknown>;
  /** Bearer token from the Authorization header, or ''. */
  bearer: string;
}

export interface RouteResult {
  status: number;
  body: unknown;
}

export type Handler = (ctx: RequestContext) => Promise<RouteResult>;

type Method = 'GET' | 'POST' | 'PATCH';

class BodyTooLargeError extends Error {}
class InvalidJsonError extends Error {}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new InvalidJsonError();
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new InvalidJsonError();
  }
}

export class Router {
  private readonly routes = new Map<string, Handler>();

  private add(method: Method, path: string, handler: Handler): this {
    this.routes.set(`${method} ${path}`, handler);
    return this;
  }

  get(path: string, handler: Handler): this { return this.add('GET', path, handler); }
  post(path: string, handler: Handler): this { return this.add('POST', path, handler); }
  patch(path: string, handler: Handler): this { return this.add('PATCH', path, handler); }

  /** Returns true when the request was handled. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';

    if (method === 'OPTIONS' && this.hasPath(url.pathname)) {
      res.writeHead(204, CORS_HEADERS).end();
      return true;
    }

    const handler = this.routes.get(`${method} ${url.pathname}`);
    if (!handler) return false;

    let body: Record<string, unknown>;
    try {
      body = method === 'GET' ? {} : await readBody(req);
    } catch (err) {
      if (err instanceof BodyTooLargeError) sendError(res, 413, 'body_too_large');
      else sendError(res, 400, 'invalid_json');
      return true;
    }

    const auth = req.headers.authorization ?? '';
    const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';

    try {
      const result = await handler({ req, url, body, bearer });
      sendJson(res, result.status, result.body);
    } catch (err) {
      // İstemciye hiçbir iç detay sızdırma; sunucu tarafında tam kaydı tut.
      console.error(`unhandled error in ${method} ${url.pathname}:`, err);
      sendError(res, 500, 'internal_error');
    }
    return true;
  }

  private hasPath(pathname: string): boolean {
    for (const key of this.routes.keys()) {
      if (key.endsWith(` ${pathname}`)) return true;
    }
    return false;
  }
}
```

- [ ] **Step 5: Testi koş, geçtiğini gör**

Run: `cd server && npm test -- --test-name-pattern="Router"`
Expected: PASS — `# pass 7`

- [ ] **Step 6: Commit**

```bash
cd server && git add src/http/router.ts src/http/respond.ts test/router.test.ts
git commit -m "feat(server): küçük HTTP yönlendirici ve JSON yanıt yardımcıları"
```

---

## Görev 13: Kimlik uç noktaları ve sunucuya bağlama

**Files:**
- Create: `server/src/auth/routes.ts`
- Create: `server/src/identity/routes.ts`
- Modify: `server/src/index.ts`
- Test: `server/test/http-identity.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

`server/test/http-identity.test.ts`:

```ts
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Router } from '../src/http/router.ts';
import { registerAuthRoutes } from '../src/auth/routes.ts';
import { registerIdentityRoutes } from '../src/identity/routes.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { query, closePool } from '../src/db/pool.ts';

let server: Server;
let base: string;

const post = (path: string, body: unknown, token?: string) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

describe('identity http', () => {
  before(async () => {
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-32b';
    process.env.EMAIL_HASH_PEPPER = 'test-pepper';
    await runMigrations();

    const router = new Router();
    registerAuthRoutes(router);
    registerIdentityRoutes(router);
    server = createServer(async (req, res) => {
      if (await router.handle(req, res)) return;
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  beforeEach(async () => { await query('delete from users'); });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await closePool();
  });

  it('GET /onboarding/bootstrap offers nicknames, countries and a region hint', async () => {
    const res = await fetch(`${base}/onboarding/bootstrap`, {
      headers: { 'x-forwarded-for': '8.8.8.8' },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      suggestedNicknames: { base: string; tag: string }[];
      suggestedRegion: string | null;
      regions: { id: string; label: string }[];
      countries: { code: string; name: string; region: string }[];
    };
    assert.equal(body.suggestedNicknames.length, 4);
    for (const s of body.suggestedNicknames) assert.match(s.tag, /^[0-9]{4}$/);
    assert.equal(body.suggestedRegion, 'NA');
    assert.equal(body.regions.length, 7);
    assert.ok(body.countries.length >= 200);
  });

  it('GET /onboarding/bootstrap returns a null region hint for a private address', async () => {
    const res = await fetch(`${base}/onboarding/bootstrap`, {
      headers: { 'x-forwarded-for': '10.0.0.1' },
    });
    assert.equal((await res.json() as { suggestedRegion: string | null }).suggestedRegion, null);
  });

  it('POST /auth/password/register returns a token and profile', async () => {
    const res = await post('/auth/password/register', {
      email: 'berkay@example.com', password: 'correct-horse',
      nicknameBase: 'TurboKral', countryCode: 'TR', region: 'MENA',
    });
    assert.equal(res.status, 201);
    const body = await res.json() as { token: string; user: { nickname: string; country: string } };
    assert.ok(body.token.length > 0);
    assert.match(body.user.nickname, /^TurboKral#[0-9]{4}$/);
    assert.equal(body.user.country, 'TR');
  });

  it('POST /auth/password/login returns 401 on a bad password', async () => {
    await post('/auth/password/register', { email: 'a@example.com', password: 'correct-horse' });
    const res = await post('/auth/password/login', { email: 'a@example.com', password: 'wrong-one-here' });
    assert.equal(res.status, 401);
    assert.equal((await res.json() as { error: string }).error, 'invalid_credentials');
  });

  it('POST /auth/password/register maps a bad nickname to 400', async () => {
    const res = await post('/auth/password/register', {
      email: 'b@example.com', password: 'correct-horse', nicknameBase: 'adminPanel',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json() as { error: string }).error, 'nickname_blocked');
  });

  it('POST /auth/social rejects an unknown provider', async () => {
    const res = await post('/auth/social', { provider: 'myspace', token: 'x' });
    assert.equal(res.status, 400);
    assert.equal((await res.json() as { error: string }).error, 'invalid_provider');
  });

  it('GET /me requires a valid session', async () => {
    assert.equal((await fetch(`${base}/me`)).status, 401);
    assert.equal(
      (await fetch(`${base}/me`, { headers: { authorization: 'Bearer nonsense' } })).status,
      401,
    );
  });

  it('GET /me returns the profile for a valid session', async () => {
    const reg = await post('/auth/password/register', {
      email: 'c@example.com', password: 'correct-horse', nicknameBase: 'GridHunter',
    });
    const { token } = await reg.json() as { token: string };
    const res = await fetch(`${base}/me`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const me = await res.json() as { nickname: string; gold: number; rankPoints: number };
    assert.match(me.nickname, /^GridHunter#[0-9]{4}$/);
    assert.equal(me.gold, 0);
    assert.equal(me.rankPoints, 0);
  });

  it('PATCH /me updates country and region', async () => {
    const reg = await post('/auth/password/register', {
      email: 'd@example.com', password: 'correct-horse',
    });
    const { token } = await reg.json() as { token: string };
    const res = await fetch(`${base}/me`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ countryCode: 'DE', region: 'EU' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { country: string; region: string };
    assert.equal(body.country, 'DE');
    assert.equal(body.region, 'EU');
  });

  it('PATCH /me rejects an unknown country or region', async () => {
    const reg = await post('/auth/password/register', {
      email: 'e@example.com', password: 'correct-horse',
    });
    const { token } = await reg.json() as { token: string };
    const bad = (payload: unknown) => fetch(`${base}/me`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    assert.equal((await bad({ countryCode: 'XX' })).status, 400);
    assert.equal((await bad({ region: 'MARS' })).status, 400);
  });

  it('never echoes the email back to the client', async () => {
    const reg = await post('/auth/password/register', {
      email: 'secret@example.com', password: 'correct-horse',
    });
    const text = await reg.text();
    assert.ok(!text.includes('secret@example.com'), 'email echoed in the response');
  });
});
```

- [ ] **Step 2: Testi koş, başarısız olduğunu gör**

Run: `cd server && DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test npm test -- --test-name-pattern="identity http"`
Expected: FAIL — `Cannot find module '../src/auth/routes.ts'`

- [ ] **Step 3: `server/src/identity/routes.ts` yaz**

```ts
/** Onboarding and profile endpoints. Spec §2.4, §2.5. */
import type { Router, RequestContext, RouteResult } from '../http/router.ts';
import { verifySession } from '../auth/jwt.ts';
import { loadUser, updateProfile, type User } from '../auth/userRepo.ts';
import { clientIpOf } from '../http/clientIp.ts';
import { regionForIp } from './ipRegion.ts';
import { COUNTRIES, isCountryCode } from './countries.ts';
import { REGIONS, REGION_LABEL, REGION_RACE_HOUR, isRegion, type Region } from './region.ts';
import { formatNickname, randomTag, suggestBases } from './nickname.ts';

/** The client-facing shape of a profile. Deliberately carries no email. */
export function publicProfile(user: User) {
  return {
    id: user.id,
    nickname: formatNickname(user.nicknameBase, user.nicknameTag),
    nicknameBase: user.nicknameBase,
    nicknameTag: user.nicknameTag,
    country: user.countryCode,
    region: user.region,
    gold: user.gold,
    rankPoints: user.rankPoints,
    createdAt: user.createdAt.toISOString(),
  };
}

async function requireUser(ctx: RequestContext): Promise<User | null> {
  const userId = await verifySession(ctx.bearer);
  return userId ? loadUser(userId) : null;
}

export function registerIdentityRoutes(router: Router): void {
  router.get('/onboarding/bootstrap', async (ctx): Promise<RouteResult> => {
    // PRIVACY: the address is read, turned into a bucket, and dropped here.
    // It is not stored, not logged, and not returned to the client.
    const ip = clientIpOf(ctx.req.headers, ctx.req.socket.remoteAddress);
    const suggestedRegion = regionForIp(ip);

    return {
      status: 200,
      body: {
        suggestedNicknames: suggestBases(4).map((base) => ({ base, tag: randomTag() })),
        suggestedRegion,
        regions: REGIONS.map((id) => ({
          id,
          label: REGION_LABEL[id],
          timeZone: REGION_RACE_HOUR[id].timeZone,
          hour: REGION_RACE_HOUR[id].hour,
        })),
        countries: COUNTRIES,
      },
    };
  });

  router.get('/me', async (ctx): Promise<RouteResult> => {
    const user = await requireUser(ctx);
    if (!user) return { status: 401, body: { error: 'unauthorized' } };
    return { status: 200, body: publicProfile(user) };
  });

  router.patch('/me', async (ctx): Promise<RouteResult> => {
    const user = await requireUser(ctx);
    if (!user) return { status: 401, body: { error: 'unauthorized' } };

    const { countryCode, region } = ctx.body;
    if (countryCode !== undefined && !isCountryCode(countryCode)) {
      return { status: 400, body: { error: 'invalid_country' } };
    }
    if (region !== undefined && !isRegion(region)) {
      return { status: 400, body: { error: 'invalid_region' } };
    }

    const updated = await updateProfile(user.id, {
      countryCode: countryCode as string | undefined,
      region: region as Region | undefined,
    });
    if (!updated) return { status: 404, body: { error: 'not_found' } };
    return { status: 200, body: publicProfile(updated) };
  });
}
```

- [ ] **Step 4: `server/src/auth/routes.ts` yaz**

```ts
/** Sign-up and sign-in endpoints. Spec §2.1. */
import type { Router, RouteResult } from '../http/router.ts';
import {
  AuthError, authenticateSocial, loginWithPassword, registerWithPassword,
  type AuthResult,
} from './service.ts';
import { publicProfile } from '../identity/routes.ts';

/** Which HTTP status each auth failure maps to. */
const STATUS_FOR: Record<string, number> = {
  invalid_token: 401,
  invalid_credentials: 401,
  email_taken: 409,
};

function success(result: AuthResult): RouteResult {
  return {
    status: result.isNew ? 201 : 200,
    body: { token: result.token, isNew: result.isNew, user: publicProfile(result.user) },
  };
}

function failure(err: unknown): RouteResult {
  if (err instanceof AuthError) {
    return { status: STATUS_FOR[err.code] ?? 400, body: { error: err.code } };
  }
  throw err; // Router bunu 500'e çevirir ve sunucu tarafında kaydeder.
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
const asOptionalString = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;

export function registerAuthRoutes(router: Router): void {
  router.post('/auth/social', async (ctx): Promise<RouteResult> => {
    try {
      return success(await authenticateSocial({
        provider: asString(ctx.body.provider),
        token: asString(ctx.body.token),
        nicknameBase: asOptionalString(ctx.body.nicknameBase),
        countryCode: asOptionalString(ctx.body.countryCode),
        region: asOptionalString(ctx.body.region),
      }));
    } catch (err) {
      return failure(err);
    }
  });

  router.post('/auth/password/register', async (ctx): Promise<RouteResult> => {
    try {
      return success(await registerWithPassword({
        email: asString(ctx.body.email),
        password: asString(ctx.body.password),
        nicknameBase: asOptionalString(ctx.body.nicknameBase),
        countryCode: asOptionalString(ctx.body.countryCode),
        region: asOptionalString(ctx.body.region),
      }));
    } catch (err) {
      return failure(err);
    }
  });

  router.post('/auth/password/login', async (ctx): Promise<RouteResult> => {
    try {
      return success(await loginWithPassword({
        email: asString(ctx.body.email),
        password: asString(ctx.body.password),
      }));
    } catch (err) {
      return failure(err);
    }
  });
}
```

- [ ] **Step 5: Testi koş, geçtiğini gör**

Run: `cd server && DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test npm test -- --test-name-pattern="identity http"`
Expected: PASS — `# pass 11`

- [ ] **Step 6: `server/src/index.ts`'e yönlendiriciyi bağla**

`server/src/index.ts` içinde, `import { League } from './league.ts';` satırının hemen altına ekle:

```ts
import { Router } from './http/router.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import { registerIdentityRoutes } from './identity/routes.ts';
import { runMigrations } from './db/migrate.ts';

const router = new Router();
registerAuthRoutes(router);
registerIdentityRoutes(router);
```

Ardından `const server = createServer(async (req, res) => {` satırının hemen altına,
mevcut `if (req.method === 'OPTIONS')` bloğundan **önce** ekle:

```ts
  // Kimlik uç noktaları önce dener; eşleşmezse lig uç noktalarına düşer.
  if (await router.handle(req, res)) return;
```

- [ ] **Step 7: Açılışta migration koştur**

`server/src/index.ts` dosyasının **sonundaki** `server.listen(...)` çağrısını bul ve
şununla değiştir (mevcut port değişkeninin adını koru):

```ts
runMigrations()
  .then(() => {
    server.listen(port, () => console.log(`pit-wall server on :${port}`));
  })
  .catch((err) => {
    console.error('migrations failed, refusing to start:', err);
    process.exit(1);
  });
```

- [ ] **Step 8: Tip denetimi ve tüm testler**

Run: `cd server && npm run typecheck`
Expected: çıktı yok (hata yok)

Run: `cd server && DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test npm test`
Expected: PASS — `# fail 0`

- [ ] **Step 9: Sunucuyu elle doğrula**

```bash
cd server && DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall \
  SESSION_SECRET=local-dev-secret-at-least-32-chars EMAIL_HASH_PEPPER=local-pepper \
  npm start
```

Başka bir kabukta:

```bash
curl -s localhost:8787/onboarding/bootstrap | head -c 400
curl -s -X POST localhost:8787/auth/password/register \
  -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"correct-horse","nicknameBase":"TurboKral","countryCode":"TR","region":"MENA"}'
```

Expected: ilk komut öneri ve ülke listesi döner; ikinci komut `{"token":"...","isNew":true,"user":{"nickname":"TurboKral#xxxx",...}}` döner.

- [ ] **Step 10: Commit**

```bash
cd server && git add src/auth/routes.ts src/identity/routes.ts src/index.ts test/http-identity.test.ts
git commit -m "feat(server): kimlik uç noktalarını sunucuya bağla"
```

---

## Görev 14: Gizlilik denetimi ve dokümantasyon

**Files:**
- Create: `server/test/privacy.test.ts`
- Modify: `server/README.md`
- Modify: `docs/FEATURES.md`

- [ ] **Step 1: Gizlilik sözleşmesini test olarak yaz**

`server/test/privacy.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('privacy contract', () => {
  it('no source file logs a client address', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(SRC)) {
      const text = await readFile(file, 'utf8');
      for (const [index, line] of text.split('\n').entries()) {
        const logs = /console\.(log|info|warn|error|debug)/.test(line);
        const mentionsIp = /\b(clientIpOf|remoteAddress|x-forwarded-for)\b/.test(line);
        if (logs && mentionsIp) offenders.push(`${file}:${index + 1}`);
      }
    }
    assert.deepEqual(offenders, [], `client address reaches a log call at: ${offenders.join(', ')}`);
  });

  it('the schema has no column that could hold a raw address or email', async () => {
    const sql = await readFile(
      fileURLToPath(new URL('../src/db/migrations/001_identity.sql', import.meta.url)), 'utf8',
    );
    assert.ok(!/\bip_address\b|\blast_ip\b/.test(sql), 'schema declares an IP column');
    assert.ok(!/^\s*email\s+text/m.test(sql), 'schema declares a raw email column');
  });

  it('clientIpOf is only ever consumed by regionForIp', async () => {
    const consumers: string[] = [];
    for (const file of await sourceFiles(SRC)) {
      if (file.endsWith('clientIp.ts')) continue;
      const text = await readFile(file, 'utf8');
      if (text.includes('clientIpOf')) consumers.push(file);
    }
    for (const file of consumers) {
      const text = await readFile(file, 'utf8');
      assert.ok(
        text.includes('regionForIp'),
        `${file} reads the client address but never passes it to regionForIp`,
      );
    }
  });
});
```

- [ ] **Step 2: Testi koş, geçtiğini gör**

Run: `cd server && npm test -- --test-name-pattern="privacy contract"`
Expected: PASS — `# pass 3`

- [ ] **Step 3: `server/README.md`'ye kimlik bölümünü ekle**

`## Uç noktalar` başlığındaki tablonun **üstüne** ekle:

````markdown
## Kimlik

Spec: [çok oyunculu kabuk tasarımı](../docs/superpowers/specs/2026-09-19-cok-oyunculu-kabuk-tasarim.md) §2

| Yöntem | Yol | Gövde | Açıklama |
|---|---|---|---|
| GET | `/onboarding/bootstrap` | — | 4 nickname önerisi, ülke listesi (endonim + bayrak kodu), region kovaları, IP'den türetilmiş region önerisi |
| POST | `/auth/social` | `provider, token, nicknameBase?, countryCode?, region?` | Google/Apple/Facebook. Yeni hesapta `201`, mevcut hesapta `200` |
| POST | `/auth/password/register` | `email, password, nicknameBase?, countryCode?, region?` | E-posta ham haliyle saklanmaz, biberli SHA-256 özeti tutulur |
| POST | `/auth/password/login` | `email, password` | Hatalı şifre ve bilinmeyen hesap aynı `401 invalid_credentials` döner |
| GET | `/me` | — | `Authorization: Bearer <token>` ister |
| PATCH | `/me` | `countryCode?, region?` | Nickname değiştirilemez |

**Gizlilik sözleşmesi.** `/onboarding/bootstrap` istemci IP'sini yalnızca region
kovasını türetmek için okur; adres hiçbir tabloya yazılmaz, hiçbir log satırına
düşmez ve istemciye geri dönmez. `test/privacy.test.ts` bunu kaynak üzerinde
denetler. Cihaz locale'i, saat dilimi veya tanımlayıcısı hiç okunmaz.

### Veritabanı

```bash
brew install postgresql@17
brew services start postgresql@17

PSQL=/opt/homebrew/opt/postgresql@17/bin/psql
$PSQL -d postgres -c "CREATE ROLE pitwall LOGIN PASSWORD 'pitwall' CREATEDB"
$PSQL -d postgres -c "CREATE DATABASE pitwall OWNER pitwall"
$PSQL -d postgres -c "CREATE DATABASE pitwall_test OWNER pitwall"

npm run migrate
```

Migration'lar sunucu açılışında da otomatik koşar; başarısız olursa sunucu
açılmaz.

### Testler

```bash
npm test          # TEST için DATABASE_URL'i pitwall_test'e yönlendir
npm run typecheck
```

### Üreteçler

`src/identity/countries.ts` ve `src/identity/ip-region-v4.bin` **üretilmiş**
dosyalardır, elle düzenlenmez:

```bash
npm run gen:countries    # CLDR'den endonim ülke adları ve region eşlemesi
npm run gen:ip-region    # RIR delegation dosyalarından /16 IP→region tablosu (ağ ister)
```
````

- [ ] **Step 4: `docs/FEATURES.md`'ye kimlik bölümünü ekle**

`## Kapsam dışı / sırada` başlığının **üstüne** ekle:

```markdown
## Kimlik ve hesap (`server/src/auth/*`, `server/src/identity/*`) — [çok oyunculu kabuk](superpowers/specs/2026-09-19-cok-oyunculu-kabuk-tasarim.md)
- ✅ **Postgres kalıcılığı**: sıralı migration koşucusu, açılışta otomatik uygulanır; başarısızsa sunucu açılmaz
- ✅ **Giriş**: Google, Apple ve Facebook token doğrulaması (JWKS / Graph debug_token) + e-posta & şifre (scrypt). Oturum kendi HS256 JWT'miz, 30 gün
- ✅ **Hesap birleştirme**: iki sağlayıcı yalnızca ikisi de **doğrulanmış** aynı e-postayı verdiğinde aynı hesaba bağlanır. Ham e-posta saklanmaz — biberli SHA-256 özeti tutulur
- ✅ **Nickname**: `taban#4hane`, tekillik çiftte. Hane rastgele (sıralı hane kayıt sayısını sızdırır), taban dolunca 5 haneye genişler. 30'luk öneri havuzu + custom taban (küfür/marka filtresi, leetspeak katlaması)
- ✅ **Ülke**: CLDR'den üretilen 200+ ülke, her biri **kendi okunuşunda** (`Türkiye`, `Deutschland`, `日本`) — uygulama diline göre değişmez. Bayraklar `flag-icons`'tan pakete gömülü
- ✅ **Region**: 7 kova (EU/NA/LATAM/MENA/APAC/SEA/OCE), her birinin günlük yarış saati var. Ülkeden ayrı alan
- ✅ **KVKK/GDPR**: region önerisi istemci IP'sinden **çevrimdışı** `/16` tablosuyla türetilir (RIR verisi, üçüncü tarafa istek yok); adres saklanmaz, log'lanmaz, istemciye dönmez. Cihaz locale/timezone hiç okunmaz. `test/privacy.test.ts` bunu kaynak üzerinde denetler
- ⬜ Mobil onboarding ekranları (Faz 1b)
```

- [ ] **Step 5: Tam doğrulama**

Run: `cd server && npm run typecheck && DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test npm test`
Expected: PASS — `# fail 0`

- [ ] **Step 6: Commit**

```bash
cd /Users/berkay/Documents/My-Projects/pit-wall
git add server/test/privacy.test.ts server/README.md docs/FEATURES.md
git commit -m "test(server): gizlilik sözleşmesi denetimi + kimlik dokümantasyonu"
```

---

## Görev 15: Railway dağıtımı

**Files:**
- Modify: `server/railway.json`
- Modify: `docs/infrastructure.md`

- [ ] **Step 1: Railway'de Postgres eklentisini bağla**

Railway projesinde sunucu servisinin yanına bir **Postgres** servisi ekle.
Railway `DATABASE_URL` değişkenini otomatik enjekte eder.

- [ ] **Step 2: Sırları Railway değişkeni olarak gir**

```
SESSION_SECRET       → openssl rand -base64 48 çıktısı
EMAIL_HASH_PEPPER    → openssl rand -base64 32 çıktısı  (ASLA döndürme)
GOOGLE_CLIENT_IDS    → iOS ve Android OAuth istemci kimlikleri, virgülle
APPLE_BUNDLE_IDS     → uygulamanın bundle id'si
FACEBOOK_APP_ID      → Meta uygulama kimliği
FACEBOOK_APP_SECRET  → Meta uygulama sırrı
```

- [ ] **Step 3: `server/railway.json`'a sağlık kontrolü ekle**

Dosyayı tamamen şununla değiştir:

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": { "builder": "NIXPACKS", "buildCommand": "npm install" },
  "deploy": {
    "startCommand": "npm start",
    "restartPolicyType": "ON_FAILURE",
    "healthcheckPath": "/state",
    "healthcheckTimeout": 60
  }
}
```

- [ ] **Step 4: `docs/infrastructure.md`'ye kimlik ortam değişkenlerini yaz**

Dosyanın sonuna ekle:

```markdown
## Kimlik servisi ortam değişkenleri

| Değişken | Kaynak | Not |
|---|---|---|
| `DATABASE_URL` | Railway Postgres eklentisi | Otomatik enjekte edilir |
| `SESSION_SECRET` | `openssl rand -base64 48` | Döndürülürse tüm oturumlar düşer (kabul edilebilir) |
| `EMAIL_HASH_PEPPER` | `openssl rand -base64 32` | **Asla döndürme** — sağlayıcılar arası hesap bağları kopar |
| `GOOGLE_CLIENT_IDS` | Google Cloud Console | iOS ve Android istemci kimlikleri, virgülle ayrılmış |
| `APPLE_BUNDLE_IDS` | Apple Developer | Uygulamanın bundle id'si |
| `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET` | Meta for Developers | |

Migration'lar açılışta otomatik koşar; başarısız olursa süreç `exit 1` ile
kapanır ve Railway dağıtımı sağlıksız sayar — yarım uygulanmış şema ile
servis vermeyiz.
```

- [ ] **Step 5: Dağıt ve doğrula**

```bash
cd /Users/berkay/Documents/My-Projects/pit-wall
git add server/railway.json docs/infrastructure.md
git commit -m "chore(server): Railway Postgres ve kimlik ortam değişkenleri"
git push
```

Dağıtım bittikten sonra:

```bash
curl -s https://<railway-domain>/onboarding/bootstrap | head -c 200
```

Expected: nickname önerileri ve ülke listesini içeren JSON.

---

## Bitiş ölçütleri

- [ ] `cd server && npm run typecheck` temiz
- [ ] `cd server && DATABASE_URL=...pitwall_test npm test` → `# fail 0`
- [ ] Dört giriş yöntemi de bir oturum token'ı üretiyor
- [ ] 60 eşzamanlı aynı-taban tahsisi 60 farklı hane veriyor
- [ ] `/onboarding/bootstrap` 200+ ülkeyi endonim adlarıyla döndürüyor
- [ ] Hiçbir tabloda ve hiçbir log satırında IP ya da ham e-posta yok (`privacy.test.ts`)
- [ ] `server/README.md` ve `docs/FEATURES.md` güncel
- [ ] Railway'de dağıtık ve `/onboarding/bootstrap` yanıt veriyor

## Sırada

**Faz 1b — Mobil onboarding:** giriş ekranı (4 yöntem), nickname seçimi, ülke
seçici (gömülü `flag-icons` SVG'leriyle), region onayı, profil ekranı, token'ın
güvenli saklanması (`expo-secure-store`) ve mevcut `gameStore`'un kimliğe
bağlanması.
