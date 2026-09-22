-- 002_lobby.sql — hesap slotları, lobiler, koltuklar ve davetler.
-- Spec: docs/superpowers/specs/2026-09-19-cok-oyunculu-kabuk-tasarim.md §3, §4.1, §6
--
-- Bu göç Faz 2'nin kapsamıdır: kimlik–slot–lobi–koltuk zinciri. `lobby_economy`
-- (ekonominin sunucuya taşınması) Faz 3'e, `friendships`/`season_archive`
-- Faz 5/4'e aittir ve burada kasıtlı olarak YOKTUR.

-- ── Hesap slotları (§4.1) ───────────────────────────────────────────────────
-- 3 slot ücretsiz gelir, 4. ve 5. 250 Altınla kalıcı olarak açılır. Satırlar
-- hesap ilk kez slotlarını istediğinde beşi birden yazılır (bkz. ensureSlots),
-- böylece "açılmamış slot" da listede gerçek bir satır olarak durur.
create table if not exists account_slots (
  user_id     uuid    not null references users(id) on delete cascade,
  slot_index  integer not null,
  unlocked    boolean not null default false,
  lobby_id    uuid,

  constraint account_slots_pk primary key (user_id, slot_index),
  constraint account_slots_index_check check (slot_index between 1 and 5)
);

-- Bir lobi aynı hesabın iki slotunda duramaz: bir oyuncu bir lobide en fazla
-- bir takım yönetir.
create unique index if not exists account_slots_user_lobby_idx
  on account_slots (user_id, lobby_id)
  where lobby_id is not null;

-- ── Lobiler (§3.1) ──────────────────────────────────────────────────────────
create table if not exists lobbies (
  id                uuid        primary key default gen_random_uuid(),
  -- Görünen ad: "Anadolu #14". Oyuncu isim yazmaz (moderasyon yükü yok);
  -- name_base + name_seq, adın çakışmasız üretilmesini sağlayan parçalardır.
  name              text        not null,
  name_base         text        not null,
  name_seq          integer     not null,
  region            text        not null,
  visibility        text        not null,
  ai_difficulty     text        not null,
  rank_min          integer     not null default 1,
  rank_max          integer     not null default 10,
  guests_can_invite boolean     not null default true,
  mid_season_join   boolean     not null default true,
  creator_user_id   uuid        not null references users(id) on delete cascade,
  season_no         integer     not null default 1,
  round_no          integer     not null default 1,
  phase             text        not null default 'open',
  next_race_at      timestamptz not null,
  created_at        timestamptz not null default now(),

  constraint lobbies_region_check check (
    region in ('EU','NA','LATAM','MENA','APAC','SEA','OCE')
  ),
  constraint lobbies_visibility_check    check (visibility in ('public','private')),
  constraint lobbies_ai_difficulty_check check (ai_difficulty in ('easy','normal','hard')),
  constraint lobbies_phase_check         check (phase in ('open','checkin','live','result','finished')),
  -- Rütbe kapısı mevcut 10 rütbeli sistemin seviyeleridir
  -- (mobile/src/data/achievements.ts `ranks`, level 1..10).
  constraint lobbies_rank_range_check    check (
    rank_min between 1 and 10 and rank_max between rank_min and 10
  ),
  constraint lobbies_round_check         check (round_no >= 1 and season_no >= 1)
);

-- Ad tahsisi bu indekse yazarak yarışır: iki eşzamanlı kurma aynı numarayı
-- alamaz, kaybeden yeniden dener (bkz. lobbyRepo.createLobby).
create unique index if not exists lobbies_name_unique on lobbies (name_base, name_seq);
-- Hızlı oyun bul adayları bölge + görünürlük + faza göre süzer.
create index if not exists lobbies_pool_idx on lobbies (region, visibility, phase);

-- ── Koltuklar (§3.2) ────────────────────────────────────────────────────────
-- Lobi kurulduğu anda 11 takımın hepsi satır olarak yazılır; insan almayanı AI
-- sürer. `managed` alanı kimin sürdüğünü söyler: human (oyuncu), assistant
-- (oyuncu var ama check-in kaçırdı — Faz 3), ai (sahipsiz).
create table if not exists lobby_seats (
  lobby_id   uuid        not null references lobbies(id) on delete cascade,
  team_key   text        not null,
  user_id    uuid        references users(id) on delete set null,
  managed    text        not null default 'ai',
  joined_at  timestamptz,

  constraint lobby_seats_pk primary key (lobby_id, team_key),
  constraint lobby_seats_managed_check check (managed in ('human','assistant','ai')),
  -- Sahipsiz koltuk 'human' olamaz; sahipli koltuk 'ai' olamaz. Veri modelinin
  -- "kart her zaman gerçek doluluğu yansıtır" (§3.4) sözünün şema tarafındaki
  -- karşılığı budur — doluluk tek bir alandan değil, ikisinin tutarlılığından
  -- okunur.
  constraint lobby_seats_owner_check check (
    (user_id is null and managed = 'ai') or (user_id is not null and managed <> 'ai')
  )
);

create index if not exists lobby_seats_user_idx on lobby_seats (user_id)
  where user_id is not null;

-- Bir oyuncu aynı lobide yalnızca bir takım yönetir.
create unique index if not exists lobby_seats_one_per_user_idx
  on lobby_seats (lobby_id, user_id)
  where user_id is not null;

-- ── Davetler (§3.6) ─────────────────────────────────────────────────────────
-- Davet BİR KOLTUĞU REZERVE ETMEZ; davetli geldiğinde o an boş olanlardan
-- seçer. Bu yüzden burada team_key yoktur ve olmamalıdır.
create table if not exists lobby_invites (
  id               uuid        primary key default gen_random_uuid(),
  lobby_id         uuid        not null references lobbies(id) on delete cascade,
  inviter_user_id  uuid        not null references users(id) on delete cascade,
  invitee_user_id  uuid        references users(id) on delete cascade,
  code             text,
  accepted_at      timestamptz,
  expires_at       timestamptz not null,
  created_at       timestamptz not null default now(),

  -- Ya belirli bir kişiye ya da paylaşılabilir bir koda düzenlenir, ikisi
  -- birden değil.
  constraint lobby_invites_target_check check (
    (invitee_user_id is not null and code is null)
    or (invitee_user_id is null and code is not null)
  )
);

create unique index if not exists lobby_invites_code_idx on lobby_invites (code)
  where code is not null;
-- Aynı kişiye aynı lobi için bekleyen ikinci bir davet açılmaz.
create unique index if not exists lobby_invites_pending_idx
  on lobby_invites (lobby_id, invitee_user_id)
  where invitee_user_id is not null and accepted_at is null;
create index if not exists lobby_invites_invitee_idx on lobby_invites (invitee_user_id)
  where invitee_user_id is not null;

-- account_slots.lobby_id, lobbies'ten önce tanımlandığı için yabancı anahtarı
-- burada eklenir. Lobi silinirse slot boşa düşer, kilidi açık kalır.
alter table account_slots
  drop constraint if exists account_slots_lobby_fk;
alter table account_slots
  add constraint account_slots_lobby_fk
  foreign key (lobby_id) references lobbies(id) on delete set null;

-- Hesabı silinen oyuncunun koltuğunu AI devralır (§3.2).
--
-- `lobby_seats.user_id` yabancı anahtarı `on delete set null`: hesap silinince
-- koltuk SATIRI durur, yalnızca sahibi düşer — lobinin 11 takımı hiçbir zaman
-- eksilmez. Ama o anda `managed` hâlâ 'human' olurdu ve yukarıdaki
-- `lobby_seats_owner_check` haklı olarak patlardı. Bu tetikleyici, sahibi
-- düşen koltuğu aynı anda AI'ya çevirerek kuralı her zaman doğru tutar.
create or replace function lobby_seat_orphan_to_ai() returns trigger as $$
begin
  if new.user_id is null then
    new.managed := 'ai';
    new.joined_at := null;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists lobby_seats_orphan_to_ai on lobby_seats;
create trigger lobby_seats_orphan_to_ai
  before update on lobby_seats
  for each row execute function lobby_seat_orphan_to_ai();
