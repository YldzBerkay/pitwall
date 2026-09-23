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
  lobby_id   uuid        not null,
  season_no  integer     not null,
  round_no   integer     not null,
  settled_at timestamptz not null default now(),

  constraint race_settlements_pk primary key (lobby_id, season_no, round_no),
  constraint race_settlements_run_fk foreign key (lobby_id, season_no, round_no)
    references race_runs (lobby_id, season_no, round_no) on delete cascade
);
