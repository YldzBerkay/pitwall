-- 013_career.sql — oyuncunun kariyeri ve hafta sonu başarımlarının dökümü.
--
-- İstemcinin yerel yerleşimi (local settlement) kaldırıldığında başarımlar ve
-- kariyer kaydı da onunla birlikte durdu — `scoreWeekend`/`recordWeekend`i
-- çağıran TEK yer oradaydı. Bu göç ertelenen o işin karşılığı: sunucu artık
-- her yarış muhasebesinde (`economy/settle.ts`) her İNSAN koltuk için
-- `@pitwall/shared/achievements`in `scoreWeekend`ini çağırıyor ve sonucu
-- `recordWeekend` ile kariyere katlıyor — AYNI transaction'da, RP'yle birlikte.
--
-- BU GÖÇTE KASITLI OLARAK YOK OLAN:
--   * `users.rank_points` — bu görev ona HİÇ DOKUNMAZ. Rank point ayrı bir
--     sayı, ayrı bir fazın (sezon hedefi) işi; kariyer skoruyla karıştırılıp
--     buradan yazılırsa iki fazın sınırı silinir.
--   * Rakip casusluk / sponsorluk gibi TAKIMA ait hiçbir alan — kariyer
--     KULLANICIYA aittir (bir oyuncu aynı anda 3-5 lobide oynar), `lobby_seats`
--     ya da `race_settlement_payouts`in team_key'ine değil `users.id`'ye bağlı
--     tek bir satırdır.
--   * AI koltukları için bir kariyer satırı — `lobby_seats_owner_check`in
--     (002_lobby.sql) kendisi zaten `managed = 'ai'` iken `user_id`nin NULL
--     olmasını zorunlu kılıyor; kullanıcısız bir kariyer diye bir şey olamaz.
--
-- ── `user_careers` — neden ayrı sütunlar, tek bir JSONB blob değil ──────────
-- `Career` (shared/src/achievements.ts) sabit, kapalı bir şekle sahip: sekiz
-- başarım anahtarının SAYACI + yedi toplam sayaç + skor. Bu depo zaten
-- `lobby_economy`nin (motor/aero/grip) ve `race_settlement_payouts`in
-- (prize/sponsor_income/brief_bonus) izlediği kuralı takip ediyor: kapalı bir
-- kümenin her üyesi kendi sütunu ve kendi `check`iyle yazılır, tek bir yarı
-- saydam blob'a gömülmez — bir sütunun eksik/yanlış yazıldığı an burada bir
-- test kırılır, JSONB'de sessizce geçer.
--
-- `score` sütununda ALT SINIR YOKTUR: `judgeTargets`in "collapsed" cezası
-- (targets.penalty, en fazla -20) negatif bir katkı üretebilir — `recordWeekend`
-- bunu olduğu gibi toplar, burada da kısıtlanmamalı, aksi halde şemanın kendisi
-- shared'in kuralını (cezanın gerçekten uygulanması) SESSİZCE bozardı.
create table if not exists user_careers (
  user_id            uuid        primary key references users(id) on delete cascade,
  score              integer     not null default 0,
  races              integer     not null default 0,
  wins               integer     not null default 0,
  podiums            integer     not null default 0,
  poles              integer     not null default 0,
  fastest_laps       integer     not null default 0,
  dnfs               integer     not null default 0,
  best_championship  integer     not null default 0,
  seasons_completed  integer     not null default 0,
  -- `Career.counts`, achievements.ts `AchievementKey`in sekiz üyesiyle birebir.
  count_podium       integer     not null default 0,
  count_pole         integer     not null default 0,
  count_fastest_lap  integer     not null default 0,
  count_win          integer     not null default 0,
  count_double       integer     not null default 0,
  count_hat_trick    integer     not null default 0,
  count_grand_slam   integer     not null default 0,
  count_clean_sweep  integer     not null default 0,
  updated_at         timestamptz not null default now(),

  -- Yalnızca SAYAÇLAR (hep 0 ya da 1 artar) negatif olamaz; `score` yukarıdaki
  -- gerekçeyle bu listenin DIŞINDA bırakıldı.
  constraint user_careers_counters_check check (
    races >= 0 and wins >= 0 and podiums >= 0 and poles >= 0 and fastest_laps >= 0
    and dnfs >= 0 and best_championship >= 0 and seasons_completed >= 0
    and count_podium >= 0 and count_pole >= 0 and count_fastest_lap >= 0 and count_win >= 0
    and count_double >= 0 and count_hat_trick >= 0 and count_grand_slam >= 0 and count_clean_sweep >= 0
  )
);

-- ── Hafta sonunun dökümü, koltuğun ödeme satırına eklenir ───────────────────
-- "Bu hafta sonu ne kazandım" ekranı ödeme dökümüyle (008_race_settlement_
-- payouts.sql) AYNI satırdan okumalı — ayrı bir tablo, aynı satırın iki
-- parçasını yapay olarak ikiye bölerdi (bu dosyanın kendi ödeme parçalarıyla
-- aynı gerekçe). AI koltuğu için ikisi de varsayılanında kalır (boş dizi,
-- sıfır) — `scoreWeekend` AI koltuğu için hiç ÇAĞRILMAZ (bkz. `settle.ts`).
alter table race_settlement_payouts
  add column if not exists achievements_earned text[]  not null default '{}',
  add column if not exists career_score        integer not null default 0;

-- Kapalı katalog: `AchievementKey`in sekiz üyesi dışında bir değer buraya asla
-- girmemeli — `upgrade-formula.test.ts`in tarama testiyle aynı ruhta, ama
-- burada bir SQL kısıtı olarak: yanlış yazılmış/uydurulmuş bir anahtar
-- migrasyon seviyesinde reddedilir, bir tarama testini beklemez.
alter table race_settlement_payouts
  add constraint race_settlement_payouts_achievements_check
  check (achievements_earned <@ array[
    'podium','pole','fastestLap','win','double','hatTrick','grandSlam','cleanSweep'
  ]::text[]);

-- `career_score`de de ALT SINIR YOK — `user_careers.score`la aynı gerekçe:
-- bu sütun tam olarak `WeekendAchievements.score`un o hafta sonu için
-- ürettiği değer, negatif olabilir (collapsed ceza).
