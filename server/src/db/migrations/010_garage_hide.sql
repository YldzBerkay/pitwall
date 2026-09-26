-- 010_garage_hide.sql — casusluğun savunma tarafı: garaj gizleme.
--
-- Faz 3b-1, casusluk kapanışı. `resolveMission` (shared/src/espionage.ts)
-- `targetHidden` gördüğünde 'blocked' döner ve oyuncunun casusluğa karşı TEK
-- savunması budur — ama sunucuda bunu saklayacak hiçbir yer yoktu, yani
-- `blocked` sunucuda asla gerçekleşemiyordu. Bu göç yalnızca o depoyu açar;
-- fiyatlandırma zaten `shared/src/economy.ts`'te (rpPrices.hide1Day,
-- goldPrices.hide3Days/hide7Days) — burada TEKRARLANMAZ.
--
-- BU GÖÇTE KASITLI OLARAK YOK OLAN: gizlemenin GEÇMİŞİ. Yalnızca "şu an
-- hangi tura kadar gizli" sorusuna cevap saklanır, ne zaman satın alındığı ya
-- da kaç kez uzatıldığı değil — hiçbir ekran bugün bunu sormuyor, ve
-- ihtiyaç duyulmayan bir dökümü şimdiden doğru tutmaya çalışmak, doğruluğunu
-- hiçbir şeyin denetlemediği veri üretmek olurdu (bkz. 009'un aynı gerekçesi).
--
-- NEDEN AYRI TABLO, `lobby_economy.spy_state` DEĞİL: `spy_state` zaten
-- bekleyen yükseltme çarpanlarının (stat etiketiyle anahtarlanan) yeri —
-- gizlemeyi oraya bir "özel anahtar" olarak sıkıştırmak iki farklı kavramı
-- (bekleyen bir görev etkisi / süregelen bir savunma durumu) aynı sütunda
-- karıştırırdı. Ayrı tablo, `garage_hides` satırının HİÇ olmaması ("hiç
-- gizlenmedi") ile `until_round`'un geçmiş bir tur olması ("gizliliği bitti")
-- arasındaki farkı da doğal olarak temsil eder.
create table if not exists garage_hides (
  lobby_id     uuid        not null references lobbies(id) on delete cascade,
  team_key     text        not null,
  -- Bu tur DAHİL gizli. `bumpGarageHide` (economy/espionageRepo.ts) bunu
  -- `greatest(mevcut, güncel tur) + gün - 1` ile hesaplar — art arda alınan
  -- gizlenmeler üst üste binmez, yalnızca uzar.
  until_round  integer     not null,
  updated_at   timestamptz not null default now(),

  constraint garage_hides_pk primary key (lobby_id, team_key),
  constraint garage_hides_until_round_check check (until_round >= 0)
);
