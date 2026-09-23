# Faz 3a-2 — Lobi Yarış Koşucusu · Uygulama Planı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lobilerde yarış koşturmak, sonucu ekonomiye bağlamak ve Faz 0'dan kalan tek global ligi kaldırmak — kazanç döngüsünü kapatarak.

**Architecture:** Yarış durumu saklanmaz; yarışı yeniden üretebilecek **tarifi** saklanır (tohum + ışıklar sönerken donan katılım + karar günlüğü). Motor deterministik olduğu için yeniden oynatma bit bazında aynı yarışı verir, yani "herkes aynı şeyi görür" yapısal bir özelliktir. Bir yarışı aynı anda tek süreç sürer (kiralama + `for update skip locked`); faz ilerlemesi veritabanı otoritelidir, bellekte zamanlayıcı yoktur.

**Tech Stack:** Node 24 · TypeScript 5.9 · tsx · `node:test` · Postgres 17 (`pg`) · `ws`

**Spec:** [2026-09-23-faz3a2-lobi-yaris-kosucusu.md](../specs/2026-09-23-faz3a2-lobi-yaris-kosucusu.md)

---

## Uygulayıcının bilmesi gerekenler

Bunlar koda bakılarak doğrulandı; varsayım değil.

### Yarış motorunun sürme yüzeyi (`@pitwall/shared/raceEngine`)

```ts
weatherFor(track: Track, seed: number): WeatherPlan
simulateQualifying(input: QualifyingInput): QualifyingResult   // → { grid: TimedEntry[], ... }
startRace(input: RaceInput): RaceState
advanceLap(state: RaceState, track: Track, decisions: Decisions): RaceState
finishRace(state: RaceState): RaceResult

type Decisions = Record<string, PitDecision | undefined>   // anahtar: carId
const carId = (e: GridEntry) => `${e.teamKey}:${e.driverIdx}`
interface PitDecision { compound: CompoundKey }
```

`QualifyingInput` alanları: `track, entries, aiBonus?, rosters?, wet, risks, round, seed`
`RaceInput` alanları: `standings, track, entries, weather, grid, round, seed, session?, aiBonus?, rosters?`

**Determinizm:** `advanceLap` rastgeleliğini `rng(state.seed * 7717 + state.round * 131 + lap * 613 + 13)` ile üretir — taşınan değişken bir durumdan değil, `(seed, round, lap)` üçlüsünden. `shared/` saflık testi ortam rastgeleliğini zaten yasaklıyor. Bu yüzden yarış, girdilerinin saf fonksiyonudur.

### Yeniden oynatmanın girdisi

Bir yarışı yeniden üretmek için **hepsi** gerekir:

| Girdi | Nereden |
|---|---|
| `seed`, `round` | Işıklar sönerken hesaplanır, saklanır |
| `track` | `trackForRound(round)` — türetilir, saklanmaz |
| `entries` | Donmuş katılım (kimin insan/asistan olduğu dahil) |
| `risks` | Takım başına sıralama yaklaşımı — **`simulateQualifying` bunu ister** |
| `standings`, `aiBonus`, `rosters` | Donmuş anlık görüntü |
| karar günlüğü | Her pit çağrısı, turuyla birlikte |

`risks`'i unutmak sık yapılan hata: ızgara ondan türüyor ve ızgara değişirse yarışın tamamı değişir.

### Faz 3a-1'den gelen kurallar

- `now` rotada `new Date()` ile örneklenir, istekten asla gelmez.
- `shared/` saftır: I/O yok, saat yok, tohumsuz rastgelelik yok.
- Bir para yazması ve muhasebesi **aynı transaction'da** olur; koruma, önceki bir okumada değil yazmanın kendi `where`'inde durur.
- **`withTransaction` yalnızca fırlatmada geri alır.** Callback'ten hata sonucu *döndürmek* yazılanı commit eder. Bu fazda da geçerli.

### Ortam

Postgres 17, port 5432, rol `pitwall`/`pitwall`, veritabanları `pitwall` / `pitwall_test`. `npm test` `--test-concurrency=1` ile koşar. Suite 413 geçiyor.

**Testleri seri koştur.** Birden fazla ajan aynı test veritabanını paylaşırsa birbirlerinin satırlarını siler; belirli bir dosyayı `npx tsx --test test/<dosya>.test.ts` ile koş, tam paketi yalnızca sonda.

Gerçek takım anahtarları: `aurelia, silberpfad, bravado, northgate, ravensworth, bosphorus, ridgeline, castellan, verano, falkirk, orenda`.

**Commit'ler:** her görevin commit mesajını kendi oturumunun attribution talimatına göre sonlandır.

`lobbies` zorunlu alanları: `name`, `name_base`, `name_seq`, ve **NOT NULL** `creator_user_id` (önce gerçek bir kullanıcı gerekir). `nickname_tag` `^[0-9]+$` kalıbına uymalı.

---

## Dosya yapısı

| Dosya | Sorumluluk |
|---|---|
| `server/src/db/migrations/004_race.sql` | Kiralama alanları, `race_runs`, `race_decisions`, `race_settlements` |
| `server/src/lobby/replay.ts` | **Saf** yeniden oynatma: tarif → `RaceState` |
| `server/src/lobby/raceRepo.ts` | Koşu, karar ve muhasebe kayıtlarının kalıcılığı |
| `server/src/lobby/lease.ts` | Yarış sahipliği: al, yenile, bırak |
| `server/src/lobby/phase.ts` | Veritabanı otoriteli faz ilerlemesi |
| `server/src/lobby/runner.ts` | Tik döngüsü, çökme sonrası devam |
| `server/src/lobby/live.ts` | Lobi başına WS odası |
| `server/src/lobby/checkin.ts` | Check-in ve pit uçları, karar günlüğü |
| `server/src/lobby/parcFerme.ts` | Claim edilmemiş işlerin değerlendirilmesi |
| `server/src/economy/settle.ts` | Yarış sonrası muhasebe, idempotent |
| `shared/src/tracks.ts` | **Değişir** — `Track.pitLaneSec` |
| `shared/src/raceEngine.ts` | **Değişir** — pit yolu başlangıcı |
| `server/src/league.ts` | **Silinir** (Görev 13) |

---

## Görev 1: `004_race.sql` şeması

**Files:**
- Create: `server/src/db/migrations/004_race.sql`
- Test: `server/test/race-schema.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

`server/test/race-schema.test.ts` — aşağıdakileri iddia etsin. Lobi kurma yardımcısını Faz 3a-1'in test dosyalarından kopyala (`server/test/economy-repo.test.ts` içindeki `makeLobby`), gerçek şemaya uyduğu doğrulanmış haldedir.

- dört şey var: `lobbies.race_owner`, `lobbies.race_lease_until`, ve `race_runs`, `race_decisions`, `race_settlements` tabloları
- `race_runs` birincil anahtarı `(lobby_id, season_no, round_no)` — aynı tur iki kez başlatılamaz
- `race_decisions` birincil anahtarı `(lobby_id, season_no, round_no, lap, team_key, driver_idx)` — **aynı turda aynı araç için ikinci karar reddedilir**
- `race_settlements` birincil anahtarı `(lobby_id, season_no, round_no)` — aynı yarış iki kez ödeyemez
- üçü de lobi silinince **cascade** ile gider
- `driver_idx` yalnızca 0 veya 1 olabilir

- [ ] **Step 2: Testi koş, başarısız olduğunu gör**

```bash
cd /Users/berkay/Documents/My-Projects/pit-wall/server
DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test npx tsx --test test/race-schema.test.ts
```

- [ ] **Step 3: `004_race.sql` yaz**

```sql
-- 004_race.sql — lobi yarışının kalıcılığı.
-- Spec: docs/superpowers/specs/2026-09-23-faz3a2-lobi-yaris-kosucusu.md §10
--
-- Yarış DURUMU saklanmaz; yarışı yeniden üretebilecek TARİF saklanır. Motor
-- deterministik olduğu için (seed, donmuş katılım, karar günlüğü) üçlüsünden
-- yeniden oynatma bit bazında aynı yarışı verir.

-- ── Yarış sahipliği ─────────────────────────────────────────────────────────
-- Bir yarışı aynı anda tek süreç sürer. Sahip kirasını yeniler; ölürse kira
-- dolar ve başka bir kopya alıp karar günlüğünden yeniden oynatarak devam eder.
alter table lobbies add column if not exists race_owner       text;
alter table lobbies add column if not exists race_lease_until timestamptz;

-- Vakti gelmiş ya da sahipsiz kalmış lobileri bulan tarama bu indeksi kullanır.
create index if not exists lobbies_due_idx on lobbies (next_race_at, phase);

-- ── Yarış koşusu ────────────────────────────────────────────────────────────
-- Işıklar sönerken bir kez yazılır ve DEĞİŞMEZ. `snapshot` yeniden oynatmanın
-- tüm girdisini taşır: entries (kimin insan/asistan olduğu dahil), risks
-- (ızgara ondan türer), standings, aiBonus, rosters.
create table if not exists race_runs (
  lobby_id    uuid        not null references lobbies(id) on delete cascade,
  season_no   integer     not null,
  round_no    integer     not null,
  seed        bigint      not null,
  snapshot    jsonb       not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,

  constraint race_runs_pk primary key (lobby_id, season_no, round_no)
);

-- ── Karar günlüğü ───────────────────────────────────────────────────────────
-- Bir pit kararı, onu tüketen tur simüle edilmeden ÖNCE buraya yazılır.
-- Birincil anahtar aynı turda aynı araç için ikinci bir kararı reddeder:
-- yeniden oynatmanın deterministik olması için günlük değişmez olmalı, yani
-- İLK karar geçerlidir.
create table if not exists race_decisions (
  lobby_id   uuid        not null,
  season_no  integer     not null,
  round_no   integer     not null,
  lap        integer     not null,
  team_key   text        not null,
  driver_idx integer     not null,
  compound   text        not null,
  created_at timestamptz not null default now(),

  constraint race_decisions_pk primary key (lobby_id, season_no, round_no, lap, team_key, driver_idx),
  constraint race_decisions_driver_check check (driver_idx in (0, 1)),
  constraint race_decisions_run_fk foreign key (lobby_id, season_no, round_no)
    references race_runs (lobby_id, season_no, round_no) on delete cascade
);

-- ── Muhasebe ────────────────────────────────────────────────────────────────
-- Yeniden oynatmanın zorunlu tamamlayıcısı: çöken bir sunucu yeniden oynatıp
-- aynı yarışı bitirebilir, ödeme iki kez yazılmamalıdır.
create table if not exists race_settlements (
  lobby_id  uuid        not null,
  season_no integer     not null,
  round_no  integer     not null,
  settled_at timestamptz not null default now(),

  constraint race_settlements_pk primary key (lobby_id, season_no, round_no),
  constraint race_settlements_run_fk foreign key (lobby_id, season_no, round_no)
    references race_runs (lobby_id, season_no, round_no) on delete cascade
);
```

- [ ] **Step 4: Testi koş, geçtiğini gör. Dev veritabanına da uygula.**

```bash
DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall npm run migrate
```

- [ ] **Step 5: Kısıtların ısırdığını kanıtla**

Üçünü tek tek boz, ilgili testin düştüğünü gör, geri al. **Üçünün de önce/sonrasını raporla.**

1. `race_decisions_pk`'dan `lap` çıkar → "aynı turda ikinci karar reddedilir" testi düşmeli.
2. `race_settlements_pk`'yı yalnızca `lobby_id` yap → "aynı yarış iki kez ödeyemez" testi düşmeli.
3. `race_runs`'tan `on delete cascade` çıkar → "lobi silinince gider" testi düşmeli.

Değiştirilmiş bir migration'ı yeniden koşturmak için önce tabloları ve `schema_migrations` satırını düşür.

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations/004_race.sql test/race-schema.test.ts
git commit -m "feat(server): lobi yarışı şeması — koşu, karar günlüğü, muhasebe"
```



---

## Görev 2: `replay.ts` — saf yeniden oynatma

> **Planın kalbi.** Buradaki determinizm, "herkes aynı yarışı görür" gereksiniminin tamamını taşıyor.

**Files:**
- Create: `server/src/lobby/replay.ts`
- Test: `server/test/race-replay.test.ts`

- [ ] **Step 1: Motorun gerçek imzalarını doğrula**

```bash
cd /Users/berkay/Documents/My-Projects/pit-wall
grep -n "^export function startRace\|^export function advanceLap\|^export function simulateQualifying\|^export function weatherFor\|^export const carId\|^export function trackForRound" shared/src/raceEngine.ts shared/src/tracks.ts
```

**Bulduklarını raporla.** Bu prompt'takinden farklıysa **koda uy**, prompt'a değil.

- [ ] **Step 2: Başarısız testi yaz**

`server/test/race-replay.test.ts` — veritabanı gerektirmez, saf fonksiyonu sınar:

- **aynı tarif iki kez oynatılınca bit bazında aynı sonuç**: iki `replayRace(...)` çağrısının döndüğü `RaceState`'ler `JSON.stringify` düzeyinde aynı
- **karar günlüğü sonucu değiştirir**: aynı tohum, farklı kararlar → farklı durum (yoksa kararlar hiç uygulanmıyor demektir)
- **kısmi oynatma tutarlı**: 40. tura kadar oynat, sonra oradan 70'e devam et; baştan 70'e oynatmakla **aynı** sonucu ver
- **turdan sonraki kararlar görmezden gelinir**: 80. tura ait bir karar, 70 turluk yarışı etkilemez
- **boş karar günlüğü çalışır**: hiç pit çağrısı olmayan yarış tamamlanır

- [ ] **Step 3: `server/src/lobby/replay.ts` yaz**

Gereken davranış:

```ts
export interface RaceSnapshot {
  entries: Entries;
  risks: Record<string, QualiRisk>;
  standings: TeamStanding[];
  aiBonus: AiBonus;
  rosters: Rosters;
}

export interface DecisionLogEntry {
  lap: number;
  teamKey: string;
  driverIdx: 0 | 1;
  compound: CompoundKey;
}

export interface ReplayInput {
  seed: number;
  round: number;
  snapshot: RaceSnapshot;
  decisions: readonly DecisionLogEntry[];
  /** Bu tura kadar oynat. Verilmezse yarış bitene kadar. */
  uptoLap?: number;
}

export function replayRace(input: ReplayInput): RaceState
```

Akış: `trackForRound(round)` → `weatherFor(track, seed)` → `simulateQualifying({track, entries, risks, wet: weather.wetAtStart, round, seed, aiBonus, rosters})` → `startRace({standings, track, entries, weather, grid, round, seed, aiBonus, rosters})` → her tur için o tura ait kararları `Decisions`'a (`carId` anahtarıyla, yani `` `${teamKey}:${driverIdx}` ``) çevirip `advanceLap`.

**Bu modül saftır:** veritabanı okumaz, saat okumaz, `Math.random()` çağırmaz. Girdiyi çağıran verir. Docblock'a yaz: yeniden oynatma bit bazında aynı olmak zorunda, çünkü çökme sonrası devam ve geç katılan istemci aynı yarışı görmeli.

- [ ] **Step 4: Testi koş, geçtiğini gör**

- [ ] **Step 5: Determinizmi kanıtla**

`replay.ts`'e `Math.random()` kullanan bir sapma ekle (örneğin kararları rastgele sırala), "bit bazında aynı" testinin **düştüğünü** gör, geri al. Önce/sonrasını raporla.

Ayrıca: `snapshot.risks`'i oynatmadan çıkar (boş nesne geç), sonucun **değiştiğini** göster — bu, `risks`'in gerçekten ızgarayı belirlediğini ve saklanması gerektiğini kanıtlar. Raporla.

- [ ] **Step 6: Commit**

```bash
git add src/lobby/replay.ts test/race-replay.test.ts
git commit -m "feat(server): saf yarış yeniden oynatması"
```

---

## Görev 3: `raceRepo.ts` — koşu, karar ve muhasebe kalıcılığı

**Files:**
- Create: `server/src/lobby/raceRepo.ts`
- Test: `server/test/race-repo.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

Kapsaması gerekenler:

- `startRun(client, {lobbyId, seasonNo, roundNo, seed, snapshot})` bir koşu yazar; aynı `(lobby, season, round)` ikinci kez **reddedilir**
- `loadRun(lobbyId, seasonNo, roundNo)` tohumu ve anlık görüntüyü geri verir (jsonb yuvarlak gidiş-dönüşü bozulmamalı — `entries` içindeki sayılar aynı kalmalı)
- `appendDecision(client, {...})` bir karar yazar; **aynı turda aynı araç için ikinci karar `false` döner**, fırlatmaz
- `loadDecisions(lobbyId, seasonNo, roundNo)` kararları **tur sırasına göre** verir
- `finishRun(client, ...)` `finished_at` damgalar
- `markSettled(client, ...)` bir muhasebe kaydı yazar; ikinci kez **`false` döner**

- [ ] **Step 2-4: Koş (FAIL) → yaz → koş (PASS)**

`appendDecision` ve `markSettled` benzersizlik ihlalini (`23505`) yakalayıp `false` döndürmeli — önce `select` ile kontrol etmemeli, o yarışır.

- [ ] **Step 5: Commit**

```bash
git add src/lobby/raceRepo.ts test/race-repo.test.ts
git commit -m "feat(server): yarış koşusu, karar günlüğü ve muhasebe deposu"
```

---

## Görev 4: `lease.ts` — yarış sahipliği

**Files:**
- Create: `server/src/lobby/lease.ts`
- Test: `server/test/race-lease.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

- `acquireDueLobbies(ownerId, now, limit)` vakti gelmiş lobileri sahiplenir ve `race_owner`/`race_lease_until` yazar
- **iki sahip aynı lobiyi alamaz**: `Promise.all` ile iki farklı `ownerId` çağırıldığında lobi yalnızca birine gider
- **süresi dolmuş kira devralınabilir**: `race_lease_until` geçmişteyse başka bir sahip alır
- **geçerli kira devralınamaz**: `race_lease_until` gelecekteyse başkası alamaz
- `renewLease(ownerId, lobbyId, now)` kirayı uzatır; **sahibi olmayan uzatamaz** (`false` döner)
- `releaseLease(ownerId, lobbyId)` bırakır

- [ ] **Step 2-4: Koş (FAIL) → yaz → koş (PASS)**

`acquireDueLobbies` `for update skip locked` kullanmalı — bekleyen değil, atlayan. Faz 3a-1'in `notify/scheduler.ts`'i aynı deseni kullanıyor, oradan bak.

Kira süresi bir sabit (`LEASE_MS`) olarak dışa verilsin ve yorumunda gerekçesi yazsın: tik aralığının birkaç katı olmalı — çok kısa olursa sağlıklı bir sahip yavaş bir tikte kirasını kaybeder, çok uzun olursa ölü bir sahibin yarışı gereksiz bekler.

- [ ] **Step 5: Tekliği kanıtla**

`for update skip locked`'ı düz `for update` yap, "iki sahip aynı lobiyi alamaz" testini **10 kez** koş. Faz 3a-1'de bunun benzeri bir durumda transaction şeklinin tek başına koruduğu görülmüştü — burada da öyleyse **dürüstçe raporla**, çünkü o zaman `skip locked` performans içindir, doğruluk için değil, ve bu ayrım belgelenmelidir.

- [ ] **Step 6: Commit**

```bash
git add src/lobby/lease.ts test/race-lease.test.ts
git commit -m "feat(server): kiralamalı yarış sahipliği"
```

---

## Görev 5: `phase.ts` — veritabanı otoriteli faz ilerlemesi

**Files:**
- Create: `server/src/lobby/phase.ts`
- Test: `server/test/race-phase.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

Faz akışı: `open → checkin (T−5dk) → live (T) → result → open (sonraki tur)`.

- `advanceDuePhases(now)` `next_race_at` − 5dk geçmiş `open` lobileri `checkin`'e taşır
- `next_race_at` geçmiş `checkin` lobileri `live`'a taşır
- vakti gelmemiş lobiye dokunmaz
- **sunucu geç kalmışsa doğru yere atlar**: `next_race_at`'i çok geçmiş bir `open` lobi doğrudan `live`'a gelir (aradaki `checkin`'i atlamak yerine sırayla geçmesi de kabul, ama sonuç `live` olmalı — hangisini seçtiğini raporla)
- `finished` lobilere dokunmaz

- [ ] **Step 2-4: Koş (FAIL) → yaz → koş (PASS)**

Bu görev **yarış koşturmaz**, yalnızca fazı ilerletir. Koşum Görev 6'da bağlanır.

- [ ] **Step 5: Commit**

```bash
git add src/lobby/phase.ts test/race-phase.test.ts
git commit -m "feat(server): veritabanı otoriteli lobi faz ilerlemesi"
```

---

## Görev 6: `runner.ts` — tik döngüsü ve çökme sonrası devam

**Files:**
- Create: `server/src/lobby/runner.ts`
- Test: `server/test/race-runner.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

- **ışıklar sönünce koşu yazılır**: `live`'a geçen bir lobide `race_runs` satırı doğar, tohum ve anlık görüntü dolu
- **tik turu ilerletir**: birkaç tik sonra durum ilerlemiş olur
- **çökme sonrası devam aynı yarışı üretir**: 40. turda koşucuyu durdur, yeni bir koşucu başlat, 40. turda **aynı duruma** gelsin (`JSON.stringify` eşitliği)
- **yarış bitince `finished_at` damgalanır ve faz `result` olur**
- **kirası olmayan koşucu tik atmaz**

- [ ] **Step 2-4: Koş (FAIL) → yaz → koş (PASS)**

Gereken davranış:

- `startRaceFor(lobbyId, now)` — ışıklar sönerken: anlık görüntüyü topla (katılım, risks, standings, aiBonus, rosters), tohumu hesapla, `startRun` ile yaz.
- **Anlık görüntü katılımı `lobby_seats` ve `lobby_economy`'den kurar.** Check-in yapmış koltuk `managed: 'human'`, yapmamış ama insan olan `'assistant'`, sahipsiz koltuk `Entries`'e hiç girmez (AI olur).
- `tickLobby(lobbyId, now)` — kirayı doğrula, mevcut turu hesapla, kararları yükle, `replayRace` ile o tura kadar oynat, bir tur ilerlet, yayınla.
- Yarış bitince `finishRun`, faz `result`, sonra bir sonraki tura `open`.

**Tohum kararlılığı:** tohum `(seasonNo, roundNo, lobbyId)`'den türetilmeli ve **saklanmalı**. Saklanan tohum otoritedir; türetme yalnızca ilk üretimde kullanılır. Aksi halde türetme formülü değişirse eski yarışlar yeniden oynatılamaz.

- [ ] **Step 5: Çökme sonrası devamı kanıtla**

Karar günlüğünü boz (bir kararı sil), çökme sonrası devam testinin **düştüğünü** gör, geri al. Bu, devamın gerçekten günlüğe dayandığını kanıtlar — yoksa test yalnızca "iki kez aynı tohumla oynatınca aynı çıkıyor" diyor olurdu.

- [ ] **Step 6: Commit**

```bash
git add src/lobby/runner.ts test/race-runner.test.ts
git commit -m "feat(server): yarış tik döngüsü ve çökme sonrası devam"
```

---

## Görev 7: `live.ts` — lobi başına WS odası

**Files:**
- Create: `server/src/lobby/live.ts`
- Modify: `server/src/index.ts`
- Test: `server/test/race-live.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

- istemci bir lobiye abone olur ve yalnızca **o lobinin** turlarını alır
- **iki lobinin yayını karışmaz**: A lobisine abone istemci B lobisinin turlarını almaz
- geç bağlanan istemci **mevcut durumu** alır (yeniden oynatmadan), sonra turları almaya devam eder
- abonelikten çıkan istemci yayın almaz
- kapanan soket odadan temizlenir (sızıntı yok)

- [ ] **Step 2-4: Koş (FAIL) → yaz → koş (PASS)**

Mevcut WS kurulumu `server/src/index.ts`'te `new WebSocketServer({ server, path: '/live' })` ve tek global yayın. Bunu odalara çevir: istemci bağlandıktan sonra `{type:'subscribe', lobbyId}` gönderir.

**Abonelik yetkilendirmesi: yalnızca o lobide koltuğu olan istemci abone olabilir.** İzleyici modu bu fazın kapsamında değil; sonradan açmak kısıtlamayı gevşetmektir, kapatmak ise geriye dönük kırıcı olurdu. Koltuğu olmayan aboneliği reddet ve bunu testle sabitle. Gerekçeyi docblock'a yaz.

- [ ] **Step 5: Commit**

```bash
git add src/lobby/live.ts src/index.ts test/race-live.test.ts
git commit -m "feat(server): lobi başına canlı yayın odası"
```

---

## Görev 8: `checkin.ts` — check-in, pit çağrısı ve karar günlüğü

**Files:**
- Create: `server/src/lobby/checkin.ts`
- Modify: `server/src/index.ts`
- Test: `server/test/race-checkin.test.ts`

> **Bu görevin kritik kuralı:** bir pit kararı, onu tüketen tur simüle edilmeden **önce** kalıcılaşmalıdır. Yazma commit olmadan istek `ok` dönmemeli.

- [ ] **Step 1: Başarısız testi yaz**

- `POST /lobby/checkin` yalnızca `checkin` fazında kabul edilir; `open` ve `live` fazlarında reddedilir
- **check-in yapmamış oyuncunun pit çağrısı reddedilir** — donmuş katılım o takımı `assistant` işaretlemiştir, kararını kabul etmek yeniden oynatmayı bozar
- `POST /lobby/pit` yalnızca `live` fazında kabul edilir
- **takım anahtarı koltuktan okunur**: gövdeye başka takım anahtarı gönderilince yok sayılır
- **aynı turda ikinci karar reddedilir** ve ilk karar geçerli kalır
- oturum yoksa 401, o lobide koltuğu yoksa 403

- [ ] **Step 2-4: Koş (FAIL) → yaz → koş (PASS)**

Uçlar gövdede `lobbyId` taşır (yönlendiricide yol parametresi yok).

- [ ] **Step 5: Yazma sırasını kanıtla**

`appendDecision`'ı yazma **başarısız olacak** şekilde boz (örneğin geçersiz bir tura yaz), isteğin `ok` **dönmediğini** ve kararın uygulanmadığını göster. Geri al. Raporla.

- [ ] **Step 6: Commit**

```bash
git add src/lobby/checkin.ts src/index.ts test/race-checkin.test.ts
git commit -m "feat(server): lobi check-in ve pit çağrısı, karar günlüğüyle"
```

---

## Görev 9: `Track.pitLaneSec`

**Files:**
- Modify: `shared/src/tracks.ts`
- Test: `server/test/track-pitlane.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

- her pistin `pitLaneSec` değeri var ve pozitif
- değerler makul bir aralıkta (pit yolundan geçmek normal turdan belirgin şekilde pahalı ama yarışı tek başına bitirmez)
- sokak pistleri ve hız pistleri farklılaşıyor (hepsi aynı değilse anlamlı bir alan)

- [ ] **Step 2-4: Koş (FAIL) → yaz → koş (PASS)**

Mevcut pist verisine bak ve karakterine göre değer ver. **`npm run econ` geçmeye devam etmeli** — geçmiyorsa denge bozulmuş demektir, kontrolü gevşetme, sebebi bul.

- [ ] **Step 5: Commit**

```bash
git add ../shared/src/tracks.ts test/track-pitlane.test.ts
git commit -m "feat(shared): piste pit yolu maliyeti ekle"
```

---

## Görev 10: Pit yolu başlangıcı (motor)

**Files:**
- Modify: `shared/src/raceEngine.ts`
- Test: `server/test/race-pitlane-start.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

- pit yolundan başlayan araç **sahanın tamamının arkasında** başlar, sonuncu grid yerinde değil
- üstüne pistin `pitLaneSec`'ine göre ölçeklenen ek boşluk alır
- **serbest lastik seçimi** kazanır
- pit yolu başlangıcı olmayan yarış bugünkü davranışla **birebir aynı** kalır (regresyon koruması: aynı tohumla eski ve yeni motor aynı sonucu vermeli)

Son madde önemli: motora dokunuyorsun ve mevcut tüm yarış davranışı korunmalı.

- [ ] **Step 2-4: Koş (FAIL) → yaz → koş (PASS)**

`GridEntry` ya da `TeamEntry`'ye pit yolu işareti ekle; `startRace` onu ilk tur konumlandırmasında kullansın. Şekli sen seç, ama **mevcut çağıranları kırma**.

- [ ] **Step 5: Regresyonu kanıtla**

Değişiklikten önce ve sonra, sabit bir tohumla tam bir yarış koştur ve sonuçların aynı olduğunu göster (pit yolu işareti yokken). Farklıysa motora istenmeyen bir etki sızmış demektir. Raporla.

- [ ] **Step 6: Commit**

```bash
git add ../shared/src/raceEngine.ts test/race-pitlane-start.test.ts
git commit -m "feat(shared): pit yolundan başlangıç"
```

---

## Görev 11: `parcFerme.ts` — claim edilmemiş işlerin değerlendirilmesi

**Files:**
- Create: `server/src/lobby/parcFerme.ts`
- Test: `server/test/race-parcferme.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

Işıklar sönmeden önce, her takım için:

| İşin durumu | Araca etkisi | Başlangıç |
|---|---|---|
| Devam ediyor | Pişen stat yarıya iner, DNF ×2 *(mevcut `crippleSetup`)* | Normal |
| **Bitti, claim edilmedi** | **Geliştirme tam işler** | **Pit yolu** |
| Bitti, claim edildi | Tam işler | Normal |

- devam eden geliştirme hâlâ aracı sakatlar (mevcut davranış korunuyor)
- **biten ama claim edilmemiş araç geliştirmesi: geliştirme işler VE takımın iki aracı da pit yolundan başlar**
- **biten ama claim edilmemiş sürücü antrenmanı: yalnızca o araç pit yolundan başlar**
- claim edilmiş iş ceza üretmez
- casus raporu araca dokunmaz, ceza üretmez

- [ ] **Step 2-4: Koş (FAIL) → yaz → koş (PASS)**

Bu modül **`pending_jobs`'u değiştirmez** — yalnızca okur ve katılım anlık görüntüsünü şekillendirir. Claim etmeyi oyuncu yapar; burada yaptığımız, claim edilmemiş bir işin yarışa nasıl girdiğini belirlemek.

- [ ] **Step 5: Commit**

```bash
git add src/lobby/parcFerme.ts test/race-parcferme.test.ts
git commit -m "feat(server): parc fermé değerlendirmesi ve pit yolu cezası"
```

---

## Görev 12: `settle.ts` — yarış muhasebesi

> **Kazanç döngüsü burada kapanıyor.**

**Files:**
- Create: `server/src/economy/settle.ts`
- Test: `server/test/race-settle.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

- yarış bitince **tüm koltukların** RP'si yazılır: yarış ödülü, sponsor ücreti, brifing bonusu
- **idempotent**: aynı yarış iki kez bitirilirse RP **bir kez** yazılır
- sıralama tablosu ve rütbe puanı güncellenir
- AI koltukları da ekonomilerini alır (yarış motorunun okuduğu tek kaynak orası)
- oyuncu uygulamayı hiç açmasa da kazancı işler — claim istemez
- **kısmi yazma yok**: muhasebe ortasında bir hata olursa hiçbir RP yazılmaz

- [ ] **Step 2-4: Koş (FAIL) → yaz → koş (PASS)**

Muhasebe `markSettled` ile aynı transaction'da koşar; `markSettled` `false` dönerse hiçbir şey yazılmaz.

**Faz 3a-1'in dersi:** `withTransaction` yalnızca fırlatmada geri alır. Callback'ten hata sonucu döndürmek yazılanı commit eder — idempotency kontrolü başarısız olduğunda **fırlat**.

Ödül miktarları için `@pitwall/shared`'daki mevcut ekonomi sabitlerine bak; yeni sayı uydurma, `npm run econ` geçmeye devam etmeli.

- [ ] **Step 5: İdempotency'yi kanıtla**

`markSettled` kontrolünü kaldır, "aynı yarış iki kez ödeyemez" testinin **düştüğünü** gör, geri al. Önce/sonraki RP sayılarını raporla.

- [ ] **Step 6: Commit**

```bash
git add src/economy/settle.ts test/race-settle.test.ts
git commit -m "feat(server): yarış muhasebesi — kazanç döngüsü kapandı"
```

---

## Görev 13: Sezon ilerlemesi ve kış reseti

**Files:**
- Modify: `server/src/lobby/runner.ts`
- Test: `server/test/race-season.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

- tur `SEASON_ROUNDS`'a ulaşınca tur 1'e döner ve sezon artar
- sezon dönünce sıralama tablosu sıfırlanır
- **kış reseti uygulanır**: araç statları `season.ts:regressCar` ile geriler, fabrika seviyeleri taşınır
- sezon dönüşü de idempotent: iki kez tetiklenirse sezon bir kez artar

- [ ] **Step 2-4: Koş (FAIL) → yaz → koş (PASS)**

Bugün `League.flag()`'in yaptığı işin lobi başına karşılığı. `regressCar`'ın imzasını **koddan doğrula**.

- [ ] **Step 5: Commit**

```bash
git add src/lobby/runner.ts test/race-season.test.ts
git commit -m "feat(server): lobi sezon ilerlemesi ve kış reseti"
```

---

## Görev 14: Eski ligin kaldırılması

**Files:**
- Delete: `server/src/league.ts`
- Modify: `server/src/index.ts`
- Test: `server/test/legacy-gone.test.ts`

- [ ] **Step 1: Başarısız testi yaz**

- `/join`, `/weekend`, `/checkin`, `/pit` uçları **404** döner (lobi uçları gövdede `lobbyId` taşıyan yeni yollarda)
- `/state` de **404** döner — tek global ligin durumunu veriyordu, karşılığı yok; lobi durumu zaten `buildSlotState` üzerinden geliyor
- sunucu açılıyor ve lobi uçları çalışıyor
- `server/src/league.ts` artık yok

- [ ] **Step 2-4: Koş (FAIL) → sil → koş (PASS)**

`index.ts`'teki tek global `League` örneğini, ona bağlı WS yayınını ve uçları kaldır. **Kimlik, lobi, ekonomi ve altın uçlarına dokunma.**

- [ ] **Step 5: Gerçek sunucuyu aç ve doğrula**

```bash
DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall SESSION_SECRET=local-dev-secret-at-least-32-chars EMAIL_HASH_PEPPER=local-pepper PORT=8795 npx tsx src/index.ts &
sleep 4
curl -s -o /dev/null -w 'bootstrap=%{http_code}\n' localhost:8795/onboarding/bootstrap
curl -s -o /dev/null -w 'join=%{http_code}\n'      localhost:8795/join
kill %1
```

`bootstrap=200`, `join=404` bekleniyor.

- [ ] **Step 6: Commit**

```bash
git add -u && git add test/legacy-gone.test.ts
git commit -m "chore(server): Faz 0'dan kalan tek global ligi kaldır"
```

---

## Görev 15: Değişmezler ve dokümantasyon

**Files:**
- Create: `server/test/race-invariants.test.ts`
- Modify: `server/README.md`, `docs/FEATURES.md`

- [ ] **Step 1: Değişmezler testini yaz**

Spec §12'nin dokuz maddesi. Her biri için önce kuralı boz, testin düştüğünü gör, geri al — **dokuz sonucu da raporla**:

1. Yeniden oynatma bit bazında aynı
2. Çökme sonrası devam aynı yarışı üretir
3. Karar, tüketen turdan önce yazılır
4. Aynı turda ikinci karar reddedilir
5. Muhasebe idempotent
6. Claim edilmemiş biten geliştirme pit yolu başlangıcı üretir **ve** geliştirme yine de işler
7. Devam eden geliştirme hâlâ aracı sakatlar
8. İki kopya aynı yarışı süremez
9. Eski uçlar gitmiştir, lobi yarışları çalışır

- [ ] **Step 2: `server/README.md`'yi güncelle**

`## Ekonomi` bölümünün altına `## Yarış` ekle, Türkçe:

- **Yarışı saklamıyoruz, tarifini saklıyoruz** — ve neden: motor deterministik, yeniden oynatma bit bazında aynı, "herkes aynı şeyi görür" yapısal bir özellik
- **Kritik kural**: pit kararı tüketen turdan önce kalıcılaşır
- Kiralamalı sahiplik ve kira süresinin neden tik aralığının birkaç katı olduğu
- Faz ilerlemesi veritabanı otoriteli; bellekte zamanlayıcı yok
- Check-in yapmamış oyuncunun pit çağrısının neden reddedildiği (donmuş katılım)
- Aynı turda **ilk** kararın geçerli olması ve nedeni
- Parc fermé / pit yolu kuralı

- [ ] **Step 3: `docs/FEATURES.md`'yi güncelle**

Faz 3a-2 bölümü, dosyanın ✅/🔶/⬜ üslubuyla. **Kazanç döngüsünün artık kapalı olduğunu** açıkça yaz. ⬜ kalanlar: kadro/sözleşme (3b), sponsor/sezon muhasebesi (3c), sezon sonu özeti ve ayrılma cezası (4), arkadaş sistemi (5), istemcinin bağlanması.

- [ ] **Step 4: Tam doğrulama**

```bash
cd /Users/berkay/Documents/My-Projects/pit-wall/server
DATABASE_URL=postgres://pitwall:pitwall@localhost:5432/pitwall_test npm test
npm run typecheck
cd ../shared && npm run typecheck
cd ../mobile && npm run typecheck && npm run econ 2>&1 | tail -3
```

- [ ] **Step 5: Commit**

```bash
cd /Users/berkay/Documents/My-Projects/pit-wall
git add server/test/race-invariants.test.ts server/README.md docs/FEATURES.md
git commit -m "test(server): yarış değişmezleri + Faz 3a-2 dokümantasyonu"
```

---

## Bitiş ölçütleri

- [ ] `shared`, `server`, `mobile` — üç tip denetimi temiz
- [ ] `npm test` sıfır hata
- [ ] `npm run econ` geçiyor
- [ ] Yeniden oynatma bit bazında aynı (bozup-düzelterek kanıtlanmış)
- [ ] Çökme sonrası devam aynı yarışı üretiyor
- [ ] Karar, tüketen turdan önce yazılıyor
- [ ] Muhasebe idempotent — aynı yarış iki kez ödemiyor
- [ ] Claim edilmemiş biten geliştirme pit yolundan başlatıyor ve yine de işliyor
- [ ] İki kopya aynı yarışı süremiyor
- [ ] Eski lig ve uçları gitmiş, sunucu açılıyor
- [ ] **Kazanç döngüsü kapalı**: yarış biten bir lobide RP artıyor

## Sırada

**Faz 3b** — kadro, sözleşme, transfer, personel.
**Faz 3c** — sponsor sözleşmeleri ve sezon muhasebesinin tamamı.
**İstemci** — mobil store'un sunucudan okuması; ayrı plan.

---

## Yürütme sırasında çıkan, sonraki görevlere taşınan bulgular

Bunlar uygulama ve inceleme sırasında keşfedildi; ilgili görevin promptuna girmeli.

### Görev 6 (`runner.ts`) için

- **Tik döngüsü her tikte baştan oynatmamalı.** Ölçüm: 70. tura yeniden oynatma
  ~0,8 ms, tur başına ~11 µs. Her tikte baştan oynatmak O(tur²) — 78 turluk bir
  yarış lobi başına ~33 ms, oysa durumu bellekte tutan tik ~0,9 ms. 300 eşzamanlı
  lobide fark 0,25 s/tik. Yeniden oynatma **devam ve geç katılım** içindir,
  sürekli hâl için değil.
- `replay.ts` bunun için `decisionsForLap(...)` dışa veriyor. Tik döngüsü tur
  gruplamasını ve `${teamKey}:${driverIdx}` anahtarlamasını **yeniden yazmamalı**;
  asla birbirinden ayrışmaması gereken mantığın tek kopyası olmalı.
- `startRace` `entries`, `standings` ve `rosters`'ı **referansla** saklıyor, yani
  `state.entries === snapshot.entries`. Durumu mutasyona uğratan her şey tarifi
  bozar ve sonraki tüm yeniden oynatmaları sessizce değiştirir.

### Görev 8 (`checkin.ts`) için

- **Tur sözleşmesi:** `state.lap === L` iken alınan bir pit çağrısı `lap: L + 1`
  olarak yazılır — henüz koşmamış ilk tur. `replay.ts`'in başlığında yazılı.
- **Asistan yönetimindeki aracın kararı motor tarafından sessizce yutuluyor**
  (`raceEngine.ts:122` — `Decisions` yalnızca `managed: 'human'` için okunuyor).
  Uç bunu reddetmeli, yoksa oyuncu hiçbir şey yapmayan bir çağrı yapmış olur.
- **Pit çağrısı iptali ifade edilemiyor.** Bugünkü `league.ts:149` `compound: null`
  ile çağrıyı geri alabiliyor; `DecisionLogEntry` `CompoundKey` zorunlu kılıyor.
  Ekleme-yalnızca bir günlük için doğru karar, ama **bilinçli** olmalı: günlüğe
  yazılmış karar geri alınamaz, çünkü geri alınabilseydi yeniden oynatma
  deterministik olmazdı.
- `loadDecisions` **tam bir sıra** dayatmalı (`order by lap, team_key, driver_idx`),
  yalnızca `lap` yetmez.

### Görev 12 (`settle.ts`) ve Görev 7 (`live.ts`) için

- `state.entries` / `state.standings` mutasyona uğratılmamalı — tarifi bozar.

### Kapsam dışı ama bilinmeli

- `RaceSnapshot`'ta `session` alanı yok, yani `startRace` hep `'race'` varsayıyor.
  Bir lobi sprint koşarsa tarifi bunu ifade edemez. Sprint uygulanırken çıkmasın.
- Şema değişmiş bir migration'ı uygulamış ortam kendiliğinden yeniden koşmaz.
  Dağıtımdan önce bu bir kereliğine elle sıfırlanmalı (dev'de yapıldı).

### Yürütmenin ortaya çıkardığı, README'ye girmesi gereken kurallar (Görev 15)

- **Havuzu ısıtmayan eşzamanlılık testi hiçbir şey kanıtlamaz.** Görev 3 ölçtü:
  30 eşzamanlı yazardan yalnızca **1'i** yarış penceresine ulaşıyordu, çünkü
  `pool.connect()` gecikmesi işi sıraya sokuyor ve kazanan diğerleri bağlantı
  almadan commit ediyor. Bilerek bozulmuş bir uygulama 5/5 geçti. Önce ~10
  önemsiz sorgu ile havuz ısıtılınca 30'un 9-10'u yarışıyor ve bozuk sürüm
  5/5 düşüyor. Her eşzamanlılık testi ısıtmalı **ve** kaç çağıranın pencereye
  ulaştığını enstrümante etmeli.
- **`for update skip locked` burada doğruluk değil verim tercihi.** Görev 4
  ölçtü: düz `for update` ile de dışlama tutuyor (10/10), çünkü bekleyenler
  READ COMMITTED altında `where`'i yeniden değerlendirip satırı düşürüyor.
  `skip locked`'ın doğrulukla ilgili tek yanı, `order by next_race_at` toplam
  bir sıra olmadığı için (bir region'da lobiler aynı yarış saatini paylaşır)
  bekleyen olmayınca kilitlenme penceresinin de olmaması.

### Görev 11 (`parcFerme.ts`) ve istemci için

- Pit yolu bayrağı: `RaceInput.pitLaneStarts?: Record<carId, { compound?: CompoundKey }>`,
  anahtar `"${teamKey}:${driverIdx}"`. Araç geliştirmesi iki anahtarı da yazar,
  sürücü antrenmanı yalnız birini.
- Motorda **Q2 lastiği kuralı yok**; var olan kısıt bir *bağlanma*:
  `CarSetup.compound` hem sıralamayı hem yarış başlangıcını besliyor. Pit
  yolundan başlayanın serbest lastiği tam olarak bundan muafiyet ve yalnızca
  ışıklar sönerken uygulanıyor — sıralama hızına dokunmuyor. **İstemci bunu
  bir kurulum değişikliği değil, yarış başlangıcı seçimi olarak sunmalı.**
