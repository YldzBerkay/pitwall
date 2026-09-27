-- 014_drivers.sql — lobi başına sürücüler: sürücülerin sunucuda var olduğu ilk göç.
-- Spec: docs/superpowers/specs/2026-09-27-faz3b2-surucu-personel.md §3, §4.
--
-- Bu göç yalnızca Aşama A'nındır: her takımın iki asıl koltuğu `teams.ts`
-- varsayılanlarından tohumlanır. BU GÖÇTE KASITLI OLARAK YOK OLAN:
--   * sözleşmeler (`seasons_left`, `wage`) — Aşama B, `driverMarket.ts`'in
--     `Contract`'ı henüz hiçbir yere yazılmıyor.
--   * yedek kadro dolgusu ve pazar imzası — Aşama B. `position` sütunu
--     `reserve`/`market`'ı KABUL EDER ama bu göç hiçbir satırı o
--     pozisyonlarla yazmaz; yarının imza göçü bu tabloyu değiştirmeden
--     INSERT edebilsin diye.
--   * sakatlıklar, antrenman durumu — Aşama D / B.
--   * personel — Aşama C, kendi tablosu.
--   * yarışa kablolama — `runner.ts`'in `rosters: {}` göndermesi bu göçle
--     DEĞİŞMİYOR; bu görevin kapsamı yalnızca "sürücüler var", "yarış
--     onları okuyor" değil (bkz. görev metninin "Do NOT wire" kuralı).
--
-- ── Kimlik ───────────────────────────────────────────────────────────────
-- `id` LOBİ İÇİNDE sabittir, global değil. Takım varsayılanları
-- `takımAnahtarı:koltukNo` alır (`teams.ts`'teki takım anahtarları benzersiz
-- olduğu için iki takım asla çakışmaz); pazardan imzalanan bir sürücü kendi
-- `driverMarket.ts` id'sini (`sezon-tur-sıra`) taşıyacak — regenerasyon
-- boyunca sabit kaldığı için sonraki bir görev "bu sürücü imzalandı"
-- diyebilir.
--
-- ── "İki yerde birden olamaz" ────────────────────────────────────────────
-- Bir satır zaten TEK bir `position` taşıdığı için bir sürücü satırı tek bir
-- yerdedir; asıl risk iki FARKLI sürücü satırının aynı takımın aynı koltuğunu
-- doldurmasıdır. Bunu TypeScript'te değil, aşağıdaki kısmi benzersiz indeks
-- veritabanında engeller.
create table if not exists lobby_drivers (
  lobby_id    uuid        not null references lobbies(id) on delete cascade,
  id          text        not null,
  -- Yalnızca pazardaki (henüz imzalanmamış) bir sürücü sahipsizdir.
  team_key    text,
  position    text        not null,
  name        text        not null,
  number      integer     not null,
  skill       integer     not null,
  stats       jsonb       not null,
  age         integer     not null,
  potential   integer     not null,
  updated_at  timestamptz not null default now(),

  constraint lobby_drivers_pk primary key (lobby_id, id),
  -- Numaralandırılmış bir sütun bir kez kontrolsüz bırakılıp küçük harf
  -- sessizce kabul edilmiş ve bir yarışı kalıcı olarak zehirlemişti — her
  -- kapalı küme kendi CHECK'ini taşır.
  constraint lobby_drivers_position_check check (position in ('seat_0', 'seat_1', 'reserve', 'market')),
  constraint lobby_drivers_team_position_check check ((position = 'market') = (team_key is null))
);

-- Bir takımın aynı koltuğunda aynı anda birden fazla sürücü OLAMAZ — kısmi
-- indeks yalnızca asıl iki koltuğu kapsar; yedek kadroda (Aşama B) aynı takım
-- için birden fazla `reserve` satırı normaldir.
create unique index if not exists lobby_drivers_seat_idx
  on lobby_drivers (lobby_id, team_key, position)
  where position in ('seat_0', 'seat_1');

create index if not exists lobby_drivers_lobby_idx on lobby_drivers (lobby_id);
