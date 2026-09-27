-- 015_practice_rosters.sql — pratik seansları da kadroyu dondurur.
--
-- Spec: bkz. görev brifi "Faz 3b-2 rosters-in-recipe" (2026-09-27).
--
-- `entries_snapshot` (012_practice.sql) yarışın kullandığı ARACI dondurur;
-- kadro (`Rosters` — hangi sürücü hangi koltukta) o donmanın DIŞINDA
-- kalmıştı çünkü sunucu henüz sürücü taşımıyordu (`014_drivers.sql`den önce).
-- Artık taşıyor, ve `runner.ts` `buildFrozenEntries` yarış ve pratik için
-- AYNI kadroyu üretiyor — bu sütun onu pratik tarafında da SAKLAR, tıpkı
-- `race_runs.snapshot`ın `rosters` alanını taşıdığı gibi.
--
-- Mevcut satırlar (bu göçten önce donmuş seanslar) `{}` alır: bu, motorun
-- kendi varsayılanıyla birebir aynı sonucu verir (bkz.
-- `runner.ts`/`raceEngine.ts`'in "seeded rosters == driverOf'un düştüğü
-- varsayılan" ispatı), yani geçmiş bir seansın klasmanı bu göçle DEĞİŞMEZ.
alter table practice_runs
  add column if not exists rosters_snapshot jsonb not null default '{}'::jsonb;

-- Aynı DEĞİŞMEZLİK garantisi `entries_snapshot`a uygulanan gerekçeyle:
-- donmuş bir seansın kadrosu bir daha asla değişmemeli.
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
  if new.rosters_snapshot is distinct from old.rosters_snapshot then
    raise exception 'practice_runs.rosters_snapshot is immutable' using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$ language plpgsql;
