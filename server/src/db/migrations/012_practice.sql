-- 012_practice.sql — pratik (FP1/FP2/FP3) seanslarının kalıcılığı.
-- Spec: bkz. görev brifi "Practice restore" (2026-09-27).
--
-- Yarışın tarifi `004_race.sql`de yaşıyor; pratik AYNI İLKEYİ ama daha küçük
-- bir yüzeyde uygular: yarışta olduğu gibi DURUM değil TARİF saklanır — bir
-- pratik seansı tohum + o anda dondurulmuş katılım + seans numarasından
-- TAMAMEN türetilebilir (`shared/src/raceEngine.ts` `simulatePractice`, saf ve
-- tohumlu). Bu göç KASITLI OLARAK şunları içermez: pratik sonucunun kendisi
-- (klasman `simulatePractice` ile istek anında türetilir, saklanmaz), pit
-- kararı günlüğü (pratikte pit kararı YOKTUR — motorun kendi sözleşmesi,
-- `PracticeInput`te `Decisions` alanı hiç yok), ve "Clean Sweep" başarımının
-- muhasebesi (o, ekonomi tarafının işi, bu şema yalnızca tarifi taşır).
--
-- ── Seans donması ───────────────────────────────────────────────────────────
-- Bir seans, vakti geldiğinde TEK SEFER donar ve bir daha DEĞİŞMEZ — tıpkı
-- `race_runs` gibi. `entries_snapshot` o anki `Entries` haritasıdır
-- (`server/src/lobby/runner.ts` `buildFrozenEntries`, yarışla PAYLAŞILAN aynı
-- donma biçimi): seans başladıktan SONRA yapılan bir setup değişikliği bu
-- seansı asla etkilemez, yalnızca BİR SONRAKİ seansı — kullanıcının onayladığı
-- tasarımın tam da dayandığı özellik budur.
--
-- `seed`/`wet` de donmanın parçası: `wet`, `weatherFor(track, seed).wetAtStart`
-- yani yarışın havasıyla AYNI (kullanıcı kararı) ama `weatherFor` `Track`
-- nesnesine ihtiyaç duyar ve `round_no`dan türetilebilir olsa da, ışıklar
-- sönmeden önce hava hesaplamasını her seansta yeniden yapmak yerine donma
-- ANINDA hesaplanan değeri saklamak, `race_runs.seed` ile aynı gerekçeyle
-- (bkz. o dosyanın başlığı) tercih edildi: donan şey SEANSIN GÖRDÜĞÜ hava,
-- ilerideki bir formül değişikliğinden ETKİLENMEMELİ.
create table if not exists practice_runs (
  lobby_id        uuid        not null references lobbies(id) on delete cascade,
  season_no       integer     not null,
  round_no        integer     not null,
  -- 1, 2 ya da 3. Sprint hafta sonunda TEK seans vardır ve o da 1 numaralıdır
  -- (bkz. görev brifi: "practiceCount = 1, matching the old client") — ayrı
  -- bir sprint numaralandırması İCAT EDİLMEDİ, aynı sütun ve aynı kısıt kalır.
  session_no      integer     not null,
  seed            integer     not null,
  wet             boolean     not null,
  entries_snapshot jsonb      not null,
  frozen_at       timestamptz not null default now(),

  constraint practice_runs_pk primary key (lobby_id, season_no, round_no, session_no),
  constraint practice_runs_round_check check (season_no >= 1 and round_no >= 1),
  -- Motorun `PracticeInput.session` tipiyle birebir aynı: `1 | 2 | 3`.
  -- Sprint hafta sonu bu aralığın İÇİNDE kalır (yalnızca 1 kullanılır),
  -- yani ayrı bir kısıt gerekmez.
  constraint practice_runs_session_check check (session_no in (1, 2, 3))
);

-- `race_runs_due_idx` (004_race.sql) benzeri: bir lobinin pratik seanslarını
-- bulmak `(lobby_id, season_no, round_no)` üzerinden olur — birincil anahtarın
-- kendisi bunu zaten karşılıyor, ayrı bir indekse gerek yok.

-- Yorumun "TEK SEFER donar ve bir daha DEĞİŞMEZ" sözünü şema tarafında GERÇEK
-- kılar — `race_runs_immutable` (004_race.sql) ile BİREBİR AYNI gerekçe:
-- `update practice_runs set entries_snapshot = ...` sessizce donmuş bir
-- seansı değiştirirdi ve "herkes aynı seansı görür" şartını tam da orada
-- kırardı. `frozen_at` (kayıt tutan alan) güncellenebilir kalır.
create or replace function practice_run_reject_recipe_update() returns trigger as $$
begin
  if new.seed is distinct from old.seed then
    raise exception 'practice_runs.seed is immutable' using errcode = 'restrict_violation';
  end if;
  if new.wet is distinct from old.wet then
    raise exception 'practice_runs.wet is immutable' using errcode = 'restrict_violation';
  end if;
  if new.entries_snapshot is distinct from old.entries_snapshot then
    raise exception 'practice_runs.entries_snapshot is immutable' using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists practice_runs_immutable on practice_runs;
create trigger practice_runs_immutable
  before update on practice_runs
  for each row execute function practice_run_reject_recipe_update();

-- `on delete cascade`: bir lobi silindiğinde onun pratik tarifleri de gitmeli
-- — `race_runs`la BİREBİR aynı karar, çünkü ikisi de o lobiye ait bir tarif
-- dışında hiçbir anlamı olmayan verilerdir; lobisiz bir pratik seansı
-- yetim bir satırdan başka bir şey değildir.
