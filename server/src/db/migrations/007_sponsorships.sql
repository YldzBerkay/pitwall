-- 007_sponsorships.sql — imzalanmış sponsorluk anlaşmaları.
-- Spec: docs/superpowers/specs sponsorluk dilimi (Faz 3a devamı).
--
-- Burada yalnızca İMZALANMIŞ anlaşmalar saklanır. `shared/src/sponsors.ts`
-- içindeki `generateOffers` tohumu tur ve şampiyona konumundan kurar
-- (`rng(round * 7919 + position * 104729)`) ve rastgeleliği YALNIZCA o
-- tohumdan çeker — koşulsuz `Math.random`/`Date.now()` çağrısı yoktur, bu
-- `shared/`'ın saflık testiyle zaten yasak. Yani teklif sayfası girdilerin
-- SAF bir fonksiyonudur: aynı tur + aynı konum + aynı `running`/`takenSlots`
-- her zaman aynı teklifleri üretir. Bu yüzden teklifler burada YOKTUR —
-- istendiğinde yeniden üretilirler, tıpkı bir yarışın durumu değil TARİFİNİN
-- saklanması gibi (bkz. 004_race.sql). Saklanması gereken tek şey, o saf
-- fonksiyonun ÜRETEMEYECEĞİ karar: oyuncunun hangi teklifi imzaladığı.
--
-- Ödeme detayı, yarış sonu mutabakatı ve uç noktalar sonraki dilimlere
-- aittir ve burada kasıtlı olarak YOKTUR.

-- ── İmzalı sponsorluklar ────────────────────────────────────────────────────
-- Bir satır = bir takımın bir slot üzerindeki anlaşması. `Sponsorship`
-- (shared/src/sponsors.ts) paket başına DEĞİL, pozisyon başına bir kayıt
-- tutar — her çizici zaten "bu slotu kim tutuyor?" diye sorar — ve `deal_id`
-- bir paketi oluşturan satırları gruplar, öyle ki bir anlaşmayı bırakmak
-- markanın satın aldığı paketin TAMAMINI geri verir, üçte ikisinde marka
-- bırakmaz.
--
-- Birincil anahtar (lobby_id, team_key, slot): bir takım aynı fiziksel
-- slotu aynı anda iki markaya SATAMAZ — araba üzerinde tek bir sidepod
-- vardır. Bu, "aynı slotta iki sponsorluk olamaz" kuralını bir sonradan
-- kontrol olarak değil, yazmanın kendisinde imkânsız kılar: check-then-act
-- yarışı yoktur çünkü ikinci INSERT birincil anahtar ihlaliyle veritabanı
-- tarafından reddedilir.
create table if not exists sponsorships (
  lobby_id        uuid    not null references lobbies(id) on delete cascade,
  team_key        text    not null,
  -- Paketi oluşturan satırları gruplar; `dealId` istemcide
  -- `${round}-${brandKey}-${slots.join('+')}` biçiminde üretilir, bu yüzden
  -- uuid değil serbest text'tir.
  deal_id         text    not null,
  -- Marka kataloğu (shared/src/sponsors.ts `brands`) kapalı bir TypeScript
  -- union'ı DEĞİL, düz `string` anahtarlı bir veri listesidir ve zamanla
  -- büyür — burada enumere edip her yeni markada bir göç zorunlu kılmak
  -- yanlış katmanda bir kısıt olurdu. `slot` ve `tier` ise shared'daki KAPALI
  -- union tiplerdir (SlotKey / SlotTier), o yüzden onlar aşağıda enumere
  -- edilir.
  brand_key       text    not null,
  slot            text    not null,
  per_race        integer not null,
  target_position integer not null,
  bonus           integer not null,
  -- Anlaşmanın imzalandığı tur.
  signed_round    integer not null,
  -- Bu turdan SONRA slot boşa çıkar.
  expires_round   integer not null,
  streak_target   integer not null,
  -- `streak_target`'ın ÜSTÜNE çıkabilir: `streakMultiplier` çarpanı orada
  -- sınırlar ama `settleRace` sayacın kendisini sınırlamaz — bir marka
  -- hedefinden daha uzun bir seri karşısında hâlâ doğru sayıyı görmek ister.
  -- Bu yüzden burada `streak <= streak_target` kısıtı YOKTUR; öyle bir kısıt
  -- gerçek oyun mekaniğini veritabanı seviyesinde bozardı.
  streak          integer not null default 0,

  constraint sponsorships_pk primary key (lobby_id, team_key, slot),
  constraint sponsorships_slot_check check (slot in (
    'sidepod', 'coverFront', 'coverMid', 'coverRear', 'noseFront', 'noseRear',
    'rearWingMain', 'rearWingTop', 'rearWingLow', 'frontWingEnd', 'frontWingFlap',
    'cockpitFront', 'cockpitRear', 'halo', 'mirror', 'floorEdge'
  )),
  constraint sponsorships_per_race_check check (per_race >= 0),
  constraint sponsorships_bonus_check check (bonus >= 0),
  -- generateOffers hedefi hep 1..12 aralığına kırpar (bkz. `Math.min(12,
  -- Math.max(1, ...))`), gridin en fazla 16 slotu olsa da hedef pozisyon
  -- şampiyonluk sırasıdır, slot sayısı değil.
  constraint sponsorships_target_check check (target_position between 1 and 12),
  constraint sponsorships_streak_check check (streak >= 0),
  constraint sponsorships_streak_target_check check (streak_target >= 1),
  constraint sponsorships_round_check check (signed_round >= 1),
  constraint sponsorships_expiry_check check (expires_round > signed_round)
);

-- `releaseSponsor`/yenileme akışı bir anlaşmanın TÜM satırlarını `deal_id`
-- ile arar; bu indeks olmadan her bırakma tam tablo taraması olurdu.
create index if not exists sponsorships_deal_idx on sponsorships (lobby_id, team_key, deal_id);
