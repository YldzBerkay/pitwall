-- 008_race_settlement_payouts.sql — yarış ödemesinin dökümü, koltuk başına.
--
-- `race_settlements` (004_race.sql) yalnızca "bu yarış ödendi mi" sorusuna
-- cevap verir: tek bir zaman damgası, hiçbir tutar taşımaz. Ama istemcinin
-- ekranı (mobile SponsorScreen/LeagueScreen) TOPLAMI değil PARÇALARI
-- gösterir: yarış ödülü, sponsor geliri, brifing bonusu, hangi hedef
-- bonuslarının kazanıldığı, hangi serilerin bozulduğu. Bu tablo o parçaların
-- KALICI kaydıdır — `economy/settle.ts` bunları zaten bellekte üretiyordu
-- (`shared/src/sponsors.ts` `settleRace`in döndürdüğü `RaceSettlementDetail`),
-- ama hiçbiri yazılmıyordu; bağlanmamış bir oyuncu ne kazandığını asla
-- öğrenemiyordu.
--
-- Bu göçte KASITLI OLARAK YOK olan: RP puanı (rank point — şampiyona puanı
-- DEĞİL, ayrı, henüz var olmayan bir mekanik) hâlâ ödenmiyor; `settle.ts`in
-- kendi yorumu bunu zaten söylüyor, burada icat edilmiyor.
--
-- NEDEN AYNI TAAHHÜT: bu tablo `race_settlements` ile AYNI muhasebe
-- garantisinin parçasıdır — `settle.ts` `markSettled` kapısından SONRA, RP'yi
-- `lobby_economy`ye yazan AYNI bağlantı ve AYNI transaction'da bu satırları
-- da yazar. Kapı + para + döküm üçü ayrı taahhütlerde olsaydı, aradan çöken
-- bir süreç ya parasız bir döküm ya da dökümsüz bir ödeme bırakabilirdi —
-- tam da bu görevin önlemesi gereken hata.
create table if not exists race_settlement_payouts (
  lobby_id        uuid    not null,
  season_no       integer not null,
  round_no        integer not null,
  team_key        text    not null,
  -- Yarıştan SONRAKİ şampiyona sırası — `SeatPayout.position` ile birebir.
  position        integer not null,
  prize           integer not null,
  sponsor_income  integer not null default 0,
  brief_bonus     integer not null default 0,
  -- Marka anahtarları (bkz. sponsorships.brand_key, 007_sponsorships.sql)
  -- kapalı bir TypeScript union'ı DEĞİL, açık bir katalog — burada da o
  -- yüzden enumere edilmiyor.
  bonuses_earned  text[]  not null default '{}',
  streaks_broken  text[]  not null default '{}',

  constraint race_settlement_payouts_pk primary key (lobby_id, season_no, round_no, team_key),
  -- `race_settlements` silinirse (ki o da `race_runs`in cascade'iyle, o da
  -- `lobbies`in cascade'iyle silinir) bu döküm de onunla gider — parasız bir
  -- muhasebe kaydı kalmadığı gibi, kaydı olmayan bir döküm de kalmaz.
  constraint race_settlement_payouts_run_fk foreign key (lobby_id, season_no, round_no)
    references race_settlements (lobby_id, season_no, round_no) on delete cascade,
  constraint race_settlement_payouts_prize_check check (prize >= 0),
  constraint race_settlement_payouts_sponsor_income_check check (sponsor_income >= 0),
  constraint race_settlement_payouts_brief_bonus_check check (brief_bonus >= 0)
);
