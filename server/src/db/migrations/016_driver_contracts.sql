-- 016_driver_contracts.sql — sürücü sözleşmeleri: bir sürücü artık sonsuza
-- dek koltukta değil.
--
-- Spec: görev metni ("Faz 3b-2 Stage B, first task: the driver market and
-- contracts"). BU GÖÇTE KASITLI OLARAK YOK OLAN:
--   * AI transfer penceresi (`runTransferWindow`) — görev metninde açıkça
--     "Do NOT build the AI transfer window" deniyor; bu göç yalnızca
--     sözleşme SAYAÇLARINI taşır, takımlar arası poaching/rookie
--     doldurmasını DEĞİL.
--   * pazarın kendisi hâlâ saklanmıyor (bkz. 014_drivers.sql'in kendi notu):
--     `shared/driverMarket.ts`'in `driverMarket()`'ı bir lobi + sezon + tur
--     için HER ZAMAN yeniden üretilir; burada saklanan tek şey "şu market
--     kimliği imzalandı" olgusu (`lobby_driver_signings`), adayların kendisi
--     değil.
--
-- ── SÖZLEŞME SÜTUNLARI ────────────────────────────────────────────────────
-- `seasons_left`/`wage`, `shared/driverMarket.ts`'in `Contract` tipiyle
-- birebir aynı alanlar — sunucu bu şekli İCAT ETMİYOR, ithal ediyor.
-- `lobby_drivers`teki her satır `team_key`si dolu olduğu sürece bir
-- sözleşme taşır (`position = 'market'` satırı hiçbir zaman yazılmıyor —
-- 014'ün kendi CHECK'i zaten bunu `team_key is null` ile eşliyor), o yüzden
-- ikisi de NOT NULL.
--
-- Bu göçten ÖNCE tohumlanmış satırlar (`seedTeamDrivers`, Aşama A) hiç
-- sözleşme taşımıyordu. SQL, `shared`in mulberry32 tohumunu (`initialContracts`)
-- yeniden üretemez — bunun yerine `wage`, zaten depolanan `skill`ten
-- (= `overallOf(stats)`, tohumda hep eşit) AYNI `driverWage` formülüyle
-- türetilir; `seasons_left` iki sezonluk nötr bir varsayılana (2) sabitlenir.
-- Bu YALNIZCA bu göçten önceki satırlar için bir yaklaşıklıktır — bundan
-- sonra `seedTeamDrivers` her yeni satırı `shared`in kendi
-- `initialContracts()`'ıyla yazar (bkz. `drivers/repo.ts`).
alter table lobby_drivers add column if not exists seasons_left integer;
alter table lobby_drivers add column if not exists wage integer;

update lobby_drivers
   set seasons_left = 2,
       wage = round(60 + ((skill - 55) / 40.0) * 190)
 where team_key is not null and seasons_left is null;

alter table lobby_drivers alter column seasons_left set not null;
alter table lobby_drivers alter column wage set not null;

alter table lobby_drivers add constraint lobby_drivers_seasons_left_check check (seasons_left > 0);
alter table lobby_drivers add constraint lobby_drivers_wage_check check (wage >= 0);

-- ── "Bu pazar kimliği zaten imzalandı" ────────────────────────────────────
-- Pazar adayları saklanmıyor, ama BİR pazar kimliğinin imzalanmış olduğu
-- OLGUSU saklanmalı — hem "aynı sürücü iki kez imzalanamaz" (spec), hem de
-- "lobinin gördüğü pazar = üretilen adaylar eksi imzalananlar" kuralı için.
--
-- Bu tablo İKİ İŞ birden görür:
--  1) "İlk imzalayan kazanır" korumasının kendisi: `primary key (lobby_id,
--     market_id)` üzerine `insert ... on conflict do nothing` — önceden bir
--     `select` değil, YAZMANIN KENDİ çakışması karar verir (bkz.
--     `sponsorships_pk`, `007_sponsorships.sql`, aynı desen).
--  2) Bir sürücünün asıl koltuğa mı yoksa yedek kadroya mı imzalandığını,
--     ve hangi takıma, hatırlamak — `lobby_drivers`teki hedef satır (bir
--     koltuk için sabit `takımAnahtarı:koltukNo` kimliğini KORUR, pazarın
--     kendi kimliğini DEĞİL, bkz. 014'ün "Kimlik" notu) bunu tek başına
--     söyleyemez.
create table if not exists lobby_driver_signings (
  lobby_id   uuid        not null references lobbies(id) on delete cascade,
  market_id  text        not null,
  team_key   text        not null,
  position   text        not null,
  signed_at  timestamptz not null default now(),

  constraint lobby_driver_signings_pk primary key (lobby_id, market_id),
  constraint lobby_driver_signings_position_check check (position in ('seat_0', 'seat_1', 'reserve'))
);
