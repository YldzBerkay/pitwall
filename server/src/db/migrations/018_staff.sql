-- 018_staff.sql — lobi başına personel (staff) pazarı ve işe alım.
-- Spec: Faz 3b-2 Aşama C'nin ilk görevi ("the staff market and hiring").
--
-- BU GÖÇTE KASITLI OLARAK YOK OLAN:
--   * personel efektlerinin yarışa/ekonomiye kablolanması (`staffEffects`)
--     — görev metni "Do NOT wire staff effects into the race or economy —
--     the next task" diyor; bu göç yalnızca personelin VAR OLMASINI ve
--     İŞE ALINABİLİR olmasını taşır.
--   * `contract_rounds`'ı tikleyen bir mekanizma — bu tam olarak yarış
--     yerleşimi (`economy/settle.ts`/`settlementRepo.ts`) tarafından
--     tetiklenecek bir şey, yani "bir sonraki görev"in kapsamı. Bu göç
--     sütunu taşır ve dolduğu andaki değerle SAKLAR; hiçbir satır burada
--     kendiliğinden azalmaz (bkz. görev raporu).
--   * takım varsayılan kadrosu (`startingRoster`, mobile'ın yalnızca kayıt
--     dosyası tohumu) — sunucuda her takım BOŞ personel koltuklarıyla
--     başlar; `staffEffects` zaten boş bir koltuğu skill-40 varsayılanı
--     gibi ele alıyor (`shared/src/staff.ts`), o yüzden sunucunun taklit
--     edeceği bir "varsayılan personel" yok.
--
-- ── Kimlik ve kapasite ──────────────────────────────────────────────────
-- `lobby_drivers`in aksine (bir koltuk `takımAnahtarı:koltukNo`), bir
-- personel koltuğunun kimliği `(lobi, takım, rol)` ÜÇLÜSÜdür — bir takımın
-- aynı rolde AYNI ANDA birden fazla başkanı olamaz (spec: "one per role").
-- Bu birincil anahtarın kendisi kapasite sınırını taşır; ayrı bir sayım
-- sorgusuna gerek yok.
create table if not exists lobby_staff (
  lobby_id         uuid        not null references lobbies(id) on delete cascade,
  team_key         text        not null,
  role             text        not null,
  -- Pazardaki adayın kendi kimliği (`${sezon}-${tur}-${rol}-${sıra}`) —
  -- adaylar hiç saklanmıyor (bkz. `lobby_staff_signings`), ama işe alınan
  -- kişinin HANGİ adaydan geldiği burada kalıcı.
  id               text        not null,
  name             text        not null,
  skill            integer     not null,
  wage             integer     not null,
  contract_rounds  integer     not null,
  hired_at         timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint lobby_staff_pk primary key (lobby_id, team_key, role),
  -- Numaralandırılmış bir sütun bir kez kontrolsüz bırakılıp bir yarışı
  -- kalıcı olarak zehirlemişti (bkz. `014_drivers.sql`'in aynı notu) — her
  -- kapalı küme kendi CHECK'ini taşır.
  constraint lobby_staff_role_check check (role in ('mechanic', 'strategist', 'pitCrew')),
  constraint lobby_staff_skill_check check (skill >= 0 and skill <= 100),
  constraint lobby_staff_wage_check check (wage >= 0),
  constraint lobby_staff_contract_rounds_check check (contract_rounds > 0)
);

create index if not exists lobby_staff_lobby_idx on lobby_staff (lobby_id);

-- ── "Bu pazar kimliği zaten işe alındı" ───────────────────────────────────
-- `lobby_driver_signings`in (`016_driver_contracts.sql`) BİREBİR aynı
-- deseni: "ilk işe alan kazanır" korumasının TAMAMI bu tablonun birincil
-- anahtarı üzerine `insert ... on conflict do nothing`dir — önceden bir
-- `select` DEĞİL, YAZMANIN KENDİ çakışması karar verir. Pazar lobi-geneli
-- olduğu için (karar: driver pazarıyla AYNI kural) bu tablo TAKIMDAN
-- BAĞIMSIZ, yalnızca (lobi, market_id) üzerine — iki farklı takım aynı
-- adayı işe almaya çalışırsa ikisi de bu fonksiyona ulaşır, yalnızca biri
-- kazanır.
create table if not exists lobby_staff_signings (
  lobby_id   uuid        not null references lobbies(id) on delete cascade,
  market_id  text        not null,
  team_key   text        not null,
  role       text        not null,
  signed_at  timestamptz not null default now(),

  constraint lobby_staff_signings_pk primary key (lobby_id, market_id),
  constraint lobby_staff_signings_role_check check (role in ('mechanic', 'strategist', 'pitCrew'))
);
