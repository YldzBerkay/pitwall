-- 003_economy.sql — lobi ekonomisi, zamanlayıcılar ve Altın muslukları.
-- Spec: docs/superpowers/specs/2026-09-22-faz3a-ekonomi-sunucuya-tasarim.md §11
--
-- Bu göç Faz 3a-1'in kapsamıdır. Yarış muhasebesi ve sezon arşivi
-- (`season_archive`) Faz 3a-2 ve Faz 4'e aittir ve burada kasıtlı olarak
-- YOKTUR.

-- ── Lobi ekonomisi ──────────────────────────────────────────────────────────
-- Bir satır = bir lobideki bir takım. AI koltukları da satır alır: yarış
-- motoru için insan ve AI arasında fark yoktur, ikisi de bir araca sahiptir.
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

-- ── Zamanlayıcılar ──────────────────────────────────────────────────────────
-- `ends_at`'in geçmesi HİÇBİR ŞEY yazmaz; yalnızca bir eşiktir. Ekonomiye yazan
-- tek şey oyuncunun claim'idir ve `claimed_at` onu idempotent kılar.
-- `notified_at` yalnızca bildirim görevinindir ve ekonomiye asla dokunmaz —
-- bu ayrım sayesinde o görev iki kez koşsa bile zarar vermez.
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

-- Bir takımın aynı türden iki AÇIK işi olamaz: tek tezgah, tek parça.
-- Kısmi indeks: claim edilmiş işler sayılmaz, yoksa oyuncu bir daha hiç
-- geliştirme başlatamazdı.
create unique index if not exists pending_jobs_open_idx
  on pending_jobs (lobby_id, team_key, kind)
  where claimed_at is null;

-- Bildirim görevinin taradığı küme.
create index if not exists pending_jobs_notify_idx
  on pending_jobs (ends_at)
  where claimed_at is null and notified_at is null;

-- ── Altın muslukları ────────────────────────────────────────────────────────
-- Aynı AdMob callback'i ya da aynı mağaza makbuzu iki kez Altın yazamaz;
-- tekilliği VERİTABANI garanti eder, uygulama mantığı değil. Kaynak anahtarın
-- parçasıdır: reklam ve mağaza kimlik uzayları birbirinden bağımsızdır.
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
