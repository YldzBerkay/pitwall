/**
 * Per-seat weekend achievements — the bridge between the race/qualifying/
 * practice DATA `economy/settle.ts` already has in hand and shared's SCORER
 * (`@pitwall/shared/achievements` `scoreWeekend`/`recordWeekend`).
 *
 * ── NEDEN BURASI shared'İ TEKRAR YAZMIYOR, TAMAMLIYOR ──────────────────────
 * `RaceResult.playerFinish` (`finishRace`, raceEngine.ts) ve
 * `QualifyingResult.playerGrid` (`simulateQualifying`) TEK bir sabit takıma
 * göre hesaplanır: `shared/src/teams.ts` `playerTeam` — ikisi de bir `teamKey`
 * PARAMETRESİ almaz. Oysa `scoreWeekend`/`judgeTargets`/`recordWeekend` bir
 * `teamKey` alır, ama hedef/ceza/bitiş-bonusu/DNF hesabı için `race.
 * playerFinish`i OKUR. Sonuç: bu ikisi lobideki 11 koltuktan yalnızca
 * `playerTeam.key`e sahip OLANI için doğru çalışır; kalan onu, KENDİ bitiş
 * sırası yerine sabit takımın bitiş sırasıyla ödüllendirir/cezalandırırdı.
 *
 * `teamPlayerFinish`/`teamGridSlots` aşağıda, `finishRace`/`simulateQualifying`
 * içindeki AYNI formülü (birebir, satır satır) rastgele bir `teamKey` için
 * yeniden üretir — shared'in KURALINI değiştirmiyor, yalnızca hangi arabaya
 * baktığını düzeltiyor. `teamRace` bu düzeltilmiş değeri taşıyan bir
 * `RaceResult` KLONU üretir (`playerFinish` üzerine yazılmış); `scoreWeekend`
 * ve `recordWeekend`e verilen budur — shared'in kendisi hiç değişmedi, hiç
 * dokunulmadı.
 *
 * ── SPRINT HAFTA SONU ───────────────────────────────────────────────────────
 * `WeekendFacts.sprint`/`sprintGrid` doldurulamaz: sprint yarışının kendi
 * sonucu sunucuda henüz kalıcı/yeniden-oynatılabilir değil (bu fazda yalnızca
 * PRATİK geri geldi — bkz. `012_practice.sql`'in kendi notu: "Clean Sweep
 * muhasebesi... ekonomi tarafının işi, bu şema yalnızca tarifi taşır"). Boş
 * bırakmak `scoreWeekend`i vakumsal-doğru yapardı (`!facts.sprint` → true),
 * yani sprint galibiyeti HİÇ doğrulanmadan Clean Sweep açılırdı. Sprint verisi
 * gerçekten var olana kadar bunu bilinçli REDDEDİYORUZ (`denyCleanSweep`) —
 * icat edilmiş bir "kaybetti" verisi uydurmak yerine.
 *
 * ── EKSİK PRATİK (geç katılım, çökmüş sunucu) ──────────────────────────────
 * Bir seans hiç donmamışsa (`loadPracticeRuns` onu hiç döndürmez) o slot için
 * gerçek bir klasman YOKTUR. `MISSING_PRACTICE_MARKER` — takımı asla eşleşmeyen
 * bir `teamKey` taşıyan TEK satırlık bir yer tutucu — o slotu "biri lider ama
 * kim olduğu bilinmiyor" olarak işaretler: `scoreWeekend`in `ledAllPractice`
 * kontrolü (`session[0]?.teamKey === teamKey`) bu yüzden HER ZAMAN false döner
 * — ne bu takım ne başka biri o slotu "liderlik etti" sayılır. Boş dizi
 * KULLANILMADI çünkü `scoreWeekend` boş diziyi "bu slotta seans yok" (sprint
 * hafta sonunun 2. ve 3. slotu gibi) diye vakumsal-doğru sayıyor — eksik bir
 * seansı öyle işaretlemek Clean Sweep'i SESSİZCE ve YANLIŞLIKLA açardı.
 */
import type { RaceResult, TimedEntry } from '@pitwall/shared/raceEngine';
import {
  scoreWeekend, recordWeekend, achievementByKey,
  type Career, type WeekendAchievements, type WeekendFacts,
} from '@pitwall/shared/achievements';

/** Never a real team's key — see this file's "EKSİK PRATİK" note. */
export const MISSING_PRACTICE_MARKER: TimedEntry = {
  teamKey: '__missing_practice_session__', driverIdx: 0, driver: '', sec: 0,
};

/**
 * A team's best CLASSIFIED finish this race, 0 if both cars retired — the
 * exact contract `RaceResult.playerFinish` documents, generalised from the
 * hardcoded `playerTeam.key` `finishRace` uses to an arbitrary `teamKey`.
 * NOT the same number `settle.ts`'s own `teamRaceFinish` computes (that one
 * returns a sponsor-judging sentinel, `teamCount * 2`, for a total DNF —
 * a deliberately different contract for a deliberately different reader).
 */
export function teamPlayerFinish(order: RaceResult['order'], teamKey: string): number {
  const classified = order.filter((e) => e.teamKey === teamKey && !e.dnf).map((e) => e.position);
  return classified.length ? Math.min(...classified) : 0;
}

/** A team's two grid slots (lead driver first), generalised from
 *  `simulateQualifying`'s own hardcoded-to-`playerTeam` `slot()`. */
export function teamGridSlots(grid: readonly TimedEntry[], teamKey: string): [number, number] {
  const slot = (idx: 0 | 1) => grid.findIndex((e) => e.teamKey === teamKey && e.driverIdx === idx) + 1;
  return [slot(0), slot(1)];
}

/** `race`, with `playerFinish` corrected for `teamKey` (see file docblock). */
export function teamRace(race: RaceResult, teamKey: string): RaceResult {
  return { ...race, playerFinish: teamPlayerFinish(race.order, teamKey) };
}

/** One practice session's timesheet, or the missing-session marker. */
function practiceTimesheet(order: TimedEntry[] | undefined): TimedEntry[] {
  return order ?? [MISSING_PRACTICE_MARKER];
}

/**
 * The 3-tuple `WeekendFacts.practice` requires. `sessions` holds whichever of
 * the weekend's REAL sessions were frozen (`undefined` for one that wasn't);
 * its length is 1 on a sprint weekend, 3 otherwise (`practiceCount`).
 *
 * A sprint weekend's slots 2 and 3 are `[]` (not the marker): those sessions
 * do not exist THIS weekend by the sport's own format, not because data went
 * missing — `scoreWeekend`'s own vacuous-truth-for-empty-session rule exists
 * for exactly this case.
 */
export function buildPracticeTuple(
  sessions: readonly (TimedEntry[] | undefined)[], sprint: boolean,
): [TimedEntry[], TimedEntry[], TimedEntry[]] {
  if (sprint) return [practiceTimesheet(sessions[0]), [], []];
  return [practiceTimesheet(sessions[0]), practiceTimesheet(sessions[1]), practiceTimesheet(sessions[2])];
}

/**
 * Strips `cleanSweep` back out of an already-scored weekend and recomputes
 * everything downstream of `base` (`rawScore`, the gated `score`) exactly as
 * `scoreWeekend` itself would have without it — no other achievement, and no
 * other field, is touched.
 */
export function denyCleanSweep(weekend: WeekendAchievements): WeekendAchievements {
  if (!weekend.earned.includes('cleanSweep')) return weekend;
  const earned = weekend.earned.filter((k) => k !== 'cleanSweep');
  const base = weekend.base - achievementByKey('cleanSweep').base;
  const rawScore = Math.round(base * weekend.multiplier) + weekend.finishBonus + weekend.briefScore;
  const score = weekend.targets.verdict === 'position' ? rawScore
    : weekend.targets.verdict === 'collapsed' ? weekend.targets.penalty
    : 0;
  return { ...weekend, earned, base, rawScore, score };
}

export interface SeatWeekendInput {
  race: RaceResult;
  /** Qualifying classification, pole first — `QualifyingResult.grid`. */
  qualifyingGrid: readonly TimedEntry[];
  /** This weekend's REAL practice sessions, in session order; a missing one is `undefined`. */
  practiceSessions: readonly (TimedEntry[] | undefined)[];
  sprint: boolean;
  /** How many of the engineer's briefing items this seat's own choices followed. */
  briefFollowed?: number;
}

/** Scores one seat's weekend — the per-seat facts assembly this whole file exists for. */
export function scoreSeatWeekend(input: SeatWeekendInput, teamKey: string): WeekendAchievements {
  const facts: WeekendFacts = {
    race: teamRace(input.race, teamKey),
    playerGrid: teamGridSlots(input.qualifyingGrid, teamKey),
    practice: buildPracticeTuple(input.practiceSessions, input.sprint),
    briefFollowed: input.briefFollowed,
  };
  const weekend = scoreWeekend(facts, teamKey);
  return input.sprint ? denyCleanSweep(weekend) : weekend;
}

/** Folds one seat's scored weekend into its user's career. */
export function recordSeatWeekend(
  career: Career, weekend: WeekendAchievements, race: RaceResult, teamKey: string,
): Career {
  return recordWeekend(career, weekend, teamRace(race, teamKey));
}
