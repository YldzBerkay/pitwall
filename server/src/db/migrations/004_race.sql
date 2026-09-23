-- 004_race.sql — lobi yarışının kalıcılığı.
-- Spec: docs/superpowers/specs/2026-09-23-faz3a2-lobi-yaris-kosucusu.md §10
--
-- Bu göç yarışın TARİFİNİ saklayan şemadır. Parc fermé değerlendirmesi (§7) ve
-- ödemenin ayrıntısı (§8 — kime ne kadar Altın/RP yazıldığı) sonraki adımlara
-- aittir ve burada kasıtlı olarak YOKTUR: burada yalnızca ödemenin bir kez
-- yapıldığını işaretleyen `race_settlements` vardır.
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
-- Sıra `(phase, next_race_at)`: tarama `phase in (...) and next_race_at <= now()`
-- biçimindedir ve Postgres önce eşitlik/IN sütununu, sonra aralığı kullanabilir.
-- Ters sırada aralık sütunu öne düşer ve `phase` süzgeci indeksten okunamaz.
-- (`lobbies_pool_idx` de aynı nedenle eşitlik sütunlarıyla başlar.)
-- Göç daha önce ters sıralı indeksi yazmış olabilir; `if not exists` onu
-- düzeltmeyeceği için önce düşürüyoruz.
drop index if exists lobbies_due_idx;
create index if not exists lobbies_due_idx on lobbies (phase, next_race_at);

-- ── Yarış koşusu ────────────────────────────────────────────────────────────
-- Işıklar sönerken bir kez yazılır ve DEĞİŞMEZ. `snapshot` yeniden oynatmanın
-- tüm girdisini taşır: entries (kimin insan/asistan olduğu dahil), risks
-- (ızgara ondan türer), standings, aiBonus, rosters.
create table if not exists race_runs (
  lobby_id    uuid        not null references lobbies(id) on delete cascade,
  season_no   integer     not null,
  round_no    integer     not null,
  -- `integer` (32 bit) KASITLIDIR, dar kalmış bir tercih değil: motorun RNG'si
  -- (shared/src/rng.ts) tohumu `seed >>> 0` ile zaten 32 bit'e kırpar, yani
  -- daha geniş saklamak yeniden oynatmaya tek bir bit katmaz. Ayrıca `bigint`
  -- node-postgres'ten JS *string* olarak döner (havuzumuz int8 için tip
  -- ayrıştırıcı kaydetmiyor), bu da `seed: number` bekleyen koda sessizce
  -- string geçirirdi. Genişletmeyin.
  seed        integer     not null,
  snapshot    jsonb       not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,

  constraint race_runs_pk primary key (lobby_id, season_no, round_no),
  constraint race_runs_round_check check (season_no >= 1 and round_no >= 1)
);

-- Yorumun "bir kez yazılır ve DEĞİŞMEZ" sözünü şema tarafında GERÇEK kılar.
-- `update race_runs set snapshot = ...` sessizce her yeniden oynatmanın
-- ürettiği yarışı değiştirirdi; tasarımın yapısal saydığı tek özellik budur,
-- bu yüzden umut yerine kısıt. `finished_at` (ve kayıt tutan diğer alanlar)
-- güncellenebilir kalır — koşucu bayrakta onu damgalar.
create or replace function race_run_reject_recipe_update() returns trigger as $$
begin
  if new.seed is distinct from old.seed then
    raise exception 'race_runs.seed is immutable' using errcode = 'restrict_violation';
  end if;
  if new.snapshot is distinct from old.snapshot then
    raise exception 'race_runs.snapshot is immutable' using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists race_runs_immutable on race_runs;
create trigger race_runs_immutable
  before update on race_runs
  for each row execute function race_run_reject_recipe_update();

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
  constraint race_decisions_lap_check check (lap >= 1),
  -- Günlük DEĞİŞMEZ olduğu için tanınmayan bir bileşik koşuyu kalıcı olarak
  -- zehirler: lastik araması `undefined` döner, yeniden oynatma yarış ortasında
  -- patlar ve satır silinemediği için yeniden denemek de kurtarmaz. Değerler
  -- shared/src/carCustomisation.ts `CompoundKey` ile birebir aynıdır.
  constraint race_decisions_compound_check check (
    compound in ('SOFT','MEDIUM','HARD','INTERMEDIATE','WET')
  ),
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
