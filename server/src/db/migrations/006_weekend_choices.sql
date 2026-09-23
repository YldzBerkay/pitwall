-- 006_weekend_choices.sql — koltuk başına hafta sonu tercihleri.
-- Spec: docs/superpowers/specs/2026-09-23-faz3a2-lobi-yaris-kosucusu.md §10 (devamı)
--
-- Faz 3a-2 `startRaceFor`i her koltuğa AYNI varsayılan setup + taktik + lastik
-- + sıralama riskiyle çalıştırıyordu (`server/src/lobby/runner.ts`
-- `DEFAULT_COMPOUND`/`DEFAULT_TACTICS`/`DEFAULT_RISK`), çünkü `lobby_seats`te
-- bu seçimleri tutacak sütun yoktu. Bu göç o deliği kapatır: dört oyuncu
-- kararı — practice bias, bileşik (sıralama lastiği ve yarış başlangıç
-- lastiği AYNI alandır, bkz. `shared/src/raceEngine.ts` `CarSetup.compound`),
-- taktik ön ayarı, sıralama riski — artık koltukla birlikte saklanıyor.
--
-- BU GÖÇÜN KASITLA GETİRMEDİĞİ:
--  - Güvenilirlik BURADA YOKTUR ve oyuncu seçimi DEĞİLDİR: fabrika
--    seviyelerinden (`lobby_economy.factory_levels`, bkz. 003. göç) türetilir
--    (`server/src/lobby/runner.ts` `reliabilityFor`). Saklanan bir sütun
--    olsaydı, fabrikaya yapılan bir yükseltme geçmişte dondurulmuş bir
--    yarışın güvenilirliğini SESSİZCE değiştirmiş gibi görünebilirdi; oysa
--    türetilen değer de tıpkı bu göçün diğer alanları gibi ışıklar sönerken
--    TEK SEFER okunup tarife donar (004'ün "durum değil tarif" kuralı).
--  - Rakip istihbaratının kalıcı AI bonusu ve lobiye özel pilot kadroları hâlâ
--    sunucuda saklanmıyor (bkz. 004_race.sql `RaceSnapshot.aiBonus`/`rosters`
--    boş kalıyor) — bu göçün konusu değil.
--
-- SEÇİMLER OPSİYONELDİR: hiçbir zaman gönderilmemiş bir koltuk yine de
-- yarışmalıdır — `runner.ts` her alan için ayrı ayrı, NULL olduğunda bugünkü
-- varsayılana düşer (`DEFAULT_COMPOUND`/`DEFAULT_TACTICS`/`DEFAULT_RISK`,
-- bias için 0). Bu yüzden dört sütun da NULL'a izin verir; NOT NULL koymak
-- "seçim yapmayan oyuncu yarışamaz" derdi ki tam tersi istenen davranış.
--
-- HER SÜTUNUN BİR CHECK'İ VAR: bu fazın az önce yaşadığı hatadan
-- (`compound text`e kısıt konmadığı için küçük harf `'soft'`un sessizce
-- kabul edilmesi — karar günlüğü DEĞİŞMEZ olduğu için bu bir yarışı KALICI
-- olarak zehirlerdi, bkz. `race_decisions_compound_check`, 004_race.sql)
-- ders çıkarılarak: enum benzeri her metin sütun kendi CHECK'iyle gelir,
-- sayısal `bias` da kendi aralık kısıtıyla.
alter table lobby_seats add column if not exists compound   text;
alter table lobby_seats add column if not exists bias       numeric;
alter table lobby_seats add column if not exists tactics    text;
alter table lobby_seats add column if not exists quali_risk text;

-- `if not exists` kısıtlarda yok; göç yeniden çalıştırılabilir kalsın diye
-- önce düşürüyoruz (004'ün `lobbies_due_idx`i, 005'in `race_runs_last_lap_check`i
-- aynı nedenle böyle yapıyor).

-- Değerler shared/src/carCustomisation.ts `CompoundKey` ile birebir aynı —
-- BÜYÜK HARF. `race_decisions_compound_check` (004) ile aynı kısıt seti.
alter table lobby_seats drop constraint if exists lobby_seats_compound_check;
alter table lobby_seats add constraint lobby_seats_compound_check check (
  compound is null or compound in ('SOFT','MEDIUM','HARD','INTERMEDIATE','WET')
);

-- shared/src/raceEngine.ts `CarSetup.bias`: kabaca -1 (tam aero) ile +1
-- (tam mekanik) arası. `effectiveStats` zaten `Math.max(-1, Math.min(1, ...))`
-- ile kırpıyor ama veritabanı kısıtı olmadan aralık dışı bir değer sessizce
-- saklanıp yalnızca OKUNURKEN kırpılırdı — yazıldığı anda reddetmek, hatayı
-- kaynağına en yakın yerde yakalar.
alter table lobby_seats drop constraint if exists lobby_seats_bias_check;
alter table lobby_seats add constraint lobby_seats_bias_check check (
  bias is null or bias between -1 and 1
);

-- shared/src/raceEngine.ts `TacticPreset`.
alter table lobby_seats drop constraint if exists lobby_seats_tactics_check;
alter table lobby_seats add constraint lobby_seats_tactics_check check (
  tactics is null or tactics in ('conservative','balanced','aggressive')
);

-- shared/src/raceEngine.ts `QualiRisk`.
alter table lobby_seats drop constraint if exists lobby_seats_quali_risk_check;
alter table lobby_seats add constraint lobby_seats_quali_risk_check check (
  quali_risk is null or quali_risk in ('safe','aggressive')
);
