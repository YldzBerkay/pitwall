/**
 * Yarış muhasebesi — kazanç döngüsünün kapandığı yer.
 *
 * Bir yarış koşuldu; bu modül onun karşılığını LOBİDEKİ HER TAKIMA yazar ve
 * şampiyona tablosunu aynı işlemde üretir.
 *
 * ── NEDEN YENİDEN OYNATMADAN OKUNUYOR ────────────────────────────────────
 * Sonuç çağırandan alınmaz, tariften (tohum + snapshot + karar günlüğü)
 * yeniden üretilir. Sebebi muhasebenin tam da çöken bir sunucu senaryosu için
 * var olması: belleğindeki `RaceState` ile ödeme yapan bir süreç, çökme
 * sonrası devralan sürece ödeyecek hiçbir şey bırakmazdı. Tarif tek gerçek
 * kaynak olduğu için ödeme de oradan çıkar; hangi süreç öderse ödesin aynı
 * sonucu okur (bkz. `replay.ts`).
 *
 * ── NEDEN `markSettled` "zaten ödendi" DEDİĞİNDE FIRLATIYORUZ ────────────
 * `withTransaction` YALNIZCA FIRLATMADA geri alır. Geri dönen bir "başarısız"
 * sonuç, o ana kadar yazılmış her şeyi TAAHHÜT EDER. Önceki fazda üç ayrı para
 * kaybı hatası tam bu şekildeydi ve hepsi aynı biçimdeydi: "başarılı bir
 * harcama, karşılığında hiçbir şey". Burada `return` yazmak tersini yapardı —
 * hiçbir şey karşılığında başarılı bir ödeme. Bu yüzden ikinci muhasebe bir
 * DEĞER değil, bir İSTİSNA döndürür: `AlreadySettledError`. Çağıran onu
 * yakalayıp yutabilir (normal bir durumdur), ama işlem çoktan geri alınmıştır.
 *
 * ── NEDEN CLAIM YOK ──────────────────────────────────────────────────────
 * Yarış kazancı claim İSTEMEZ. Claim mekaniği fabrika/antrenman işlerine
 * aittir: orada oyuncu bir işi BAŞLATIR ve bittiğinde teslim alır, yani claim
 * o işin son adımıdır. Yarış öyle değil — yarış oyuncu uygulamayı açmasa da
 * koşar ve biter. Kazancı claim'e bağlamak, uygulamayı açmayan oyuncuyu
 * cezalandırır ve ligin ekonomisini oyuncuların çevrimiçi alışkanlığına
 * bağlar (Faz 3a-2 spec §8, Faz 3a-1 spec §5.3). Bunu "tutarlılık" adına
 * claim'li hale getirmek mekaniğin sınırını siler; sınır kasıtlıdır.
 *
 * ── NEDEN AI KOLTUKLARI DA ÖDENİR ────────────────────────────────────────
 * Yarış motoru her takımın aracını `lobby_economy`den okur. Ödenmeyen bir AI
 * takımı hiç geliştirme yapamaz, bir sezon boyunca geriler ve ızgara çürür —
 * yani insan oyuncunun rakipsiz kalması. Ödeme koltuğun kime ait olduğuna
 * DEĞİL, lobide bir ekonomi satırı olup olmadığına bakar.
 *
 * `now` her zaman çağırandan gelir; bu modül saati asla kendisi okumaz
 * (server/README.md).
 */
import type { PoolClient } from 'pg';
import { finishRace, weatherFor, type FinishEntry, type TimedEntry } from '@pitwall/shared/raceEngine';
import { racePrize, settleRace as settleSponsorships } from '@pitwall/shared/sponsors';
import { briefFor, briefCompliance, BRIEF_RP_EACH, type WeekendChoices } from '@pitwall/shared/brief';
import { trackForRound } from '@pitwall/shared/tracks';
import type { TeamStanding } from '@pitwall/shared/teams';
import { rivalAttempt, RIVAL_GAIN } from '@pitwall/shared/espionage';
import { withTransaction } from '../db/pool.ts';
import { loadDecisions, loadRun, markSettled } from '../lobby/raceRepo.ts';
import { loadSeats, type Seat } from '../lobby/lobbyRepo.ts';
import { replayRace, qualifyingForRecipe } from '../lobby/replay.ts';
import { loadPracticeRuns, derivePracticeResult, practiceCount } from '../lobby/practice.ts';
import { addRp, bumpCarStat, loadLobbyEconomy, type CarStats } from './repo.ts';
import { isGarageHidden } from './espionageRepo.ts';
import { deleteDeal, loadTeamSponsorships, setStreak } from './sponsorshipRepo.ts';
import { insertSettlementPayout } from './settlementRepo.ts';
import { scoreSeatWeekend, recordSeatWeekend } from './weekendAchievements.ts';
import { loadCareerForUpdate, saveCareer } from './careerRepo.ts';
import type { AchievementKey } from '@pitwall/shared/achievements';
import { tickStaffContracts } from '../staff/repo.ts';

const CAR_STAT_FIELDS: (keyof CarStats)[] = ['motor', 'aero', 'grip'];

/**
 * Rival espionage against human seats — ambient intelligence, not a player's
 * job. It has no start, no claim, no client request behind it at all: it is
 * something the grid does to a human seat whether or not anyone is looking,
 * which is exactly what settlement already is for every OTHER ambient
 * outcome here (prize money, sponsor income). So it runs HERE, once per
 * settled race, per human seat — never on a timer, never at claim, and never
 * against an AI-run seat (nothing reads an AI seat's spy news, and only a
 * human's championship POSITION is meaningful bait per
 * `shared/src/espionage.ts`'s own front-of-the-table rule).
 *
 * Exported and given its own client/data parameters (rather than folded
 * inline into `writePayouts`) so a test can drive it directly with a small
 * fixture — the roll is seeded on `(round, season)`, not on the stochastic
 * race result, so nothing about it actually needs a real replayed race to
 * exercise.
 *
 * Returns a `teamKey -> { team, success }` map of every seat that was
 * ACTUALLY attempted this round (a seat never rolled — not front-of-table,
 * or the 20% roll missed, see `rivalAttempt` — has no entry at all, never a
 * fabricated "not attempted" record). `writePayouts` folds this into each
 * seat's settlement row so a player can finally learn what an ambient
 * attempt against them did, the same gap `010_garage_hide.sql` closed for
 * the DEFENSIVE half of espionage.
 */
export async function runRivalEspionage(
  client: PoolClient,
  lobbyId: string,
  seasonNo: number,
  roundNo: number,
  seats: Seat[],
  positionOf: Map<string, number>,
  rivalPool: string[],
): Promise<Map<string, { team: string; success: boolean }>> {
  const results = new Map<string, { team: string; success: boolean }>();
  for (const seat of seats) {
    if (seat.managed !== 'human') continue;
    const position = positionOf.get(seat.teamKey) ?? Number.POSITIVE_INFINITY;
    const hidden = await isGarageHidden(lobbyId, seat.teamKey, roundNo, client);
    const rivals = rivalPool.filter((k) => k !== seat.teamKey);
    const attempt = rivalAttempt(roundNo, seasonNo, position, hidden, rivals);
    if (!attempt) continue;
    results.set(seat.teamKey, attempt);
    if (!attempt.success) continue;
    // No single stat is "the" one a rival's ambient snoop improves — unlike
    // a player's OWN mission (which always names one) this has none to name.
    // The client's equivalent (`aiBonus`) was a single flat number added to
    // the WHOLE team's strength; a team's three `car` fields are seeded
    // equal (`repo.ts`'s `startingCar`) and meant to move together at this
    // level, so applying the full `RIVAL_GAIN` to each keeps that same
    // one-number-per-team shape rather than arbitrarily picking a field.
    for (const field of CAR_STAT_FIELDS) {
      await bumpCarStat(client, lobbyId, attempt.team, field, RIVAL_GAIN);
    }
  }
  return results;
}

export interface SettleRaceInput {
  lobbyId: string;
  seasonNo: number;
  roundNo: number;
  now: Date;
}

/**
 * Bir takımın bu yarıştan aldığı — hem TOPLAM (`rp`, geçmişte olduğu gibi
 * `addRp`'ye giden tek sayı) hem de o toplamı oluşturan PARÇALAR.
 *
 * Parçalar `race_settlement_payouts`e (bkz. `settlementRepo.ts`) BİREBİR
 * aynı şekilde yazılır — istemcinin ekranı (SponsorScreen/LeagueScreen)
 * toplamı değil dökümü gösterdiği için, `rp`yi tek bir sayıya sıkıştırıp
 * geri kalanı atmak oyuncuya parasının nereden geldiğini asla anlatamazdı.
 * `rp === prize + sponsorIncome + briefBonus` HER ZAMAN doğrudur — üçü de
 * aynı döngüde, aynı toplamı biriktirerek hesaplanır (aşağıdaki
 * `writePayouts`e bakın), ayrı bir yeniden hesaplama YOKTUR.
 */
export interface SeatPayout {
  teamKey: string;
  /** Yarıştan SONRAKİ şampiyona sırası — ödülün okunduğu yer. */
  position: number;
  rp: number;
  /** `racePrize(position, ...)` — şampiyona sırasının garantili tabanı. */
  prize: number;
  /** Aktif sponsorlukların bu yarış için toplam katkısı (perRace + bonus). */
  sponsorIncome: number;
  /** Brifing uyumundan gelen kısım; hafta sonu seçimi yoksa (AI) sıfır. */
  briefBonus: number;
  /** Hedefini tutturan sponsorların marka anahtarları. */
  bonusesEarned: string[];
  /** Serisi bu yarışta sıfırlanan sponsorların marka anahtarları. */
  streaksBroken: string[];
  /**
   * Bu turun sonunda süresi dolan sponsorluk POZİSYONLARI (`SlotKey`) —
   * aşağıda gerçekten silinenlerin ta kendisi, ayrı bir yeniden hesaplama
   * DEĞİL. Silme kalıcı olduğu için, yazılmazsa oyuncunun kapanan
   * sözleşmeyi öğrenmesinin hiçbir yolu kalmazdı (bkz.
   * `009_settlement_expired_slots.sql`).
   */
  expiredSlots: string[];
  /**
   * Bu hafta sonu kazanılan başarımlar — yalnızca İNSAN (ya da asistanla
   * sürülen, yani sahibi olan) koltuklar için doldurulur; AI koltuğu için
   * her zaman boş dizi (`scoreWeekend` AI koltuk için hiç ÇAĞRILMAZ, bkz.
   * `weekendAchievements.ts`).
   */
  achievementsEarned: AchievementKey[];
  /** O hafta sonunun kariyer skoruna kattığı miktar — negatif olabilir
   *  (collapsed ceza, bkz. `013_career.sql`). AI koltuğu için 0. */
  careerScore: number;
}

export interface RaceSettlement {
  /** Yarış işlendikten sonraki şampiyona tablosu. */
  standings: TeamStanding[];
  payouts: SeatPayout[];
}

/**
 * "Bu yarış zaten ödendi."
 *
 * Bir HATA değil, beklenen bir sondur: çöken bir sunucu aynı yarışı ikinci kez
 * bitirebilir. Yine de istisna olarak atılır, çünkü işlemin GERİ ALINMASI
 * gerekir — yukarıdaki `withTransaction` notuna bakın.
 */
export class AlreadySettledError extends Error {
  constructor(readonly lobbyId: string, readonly seasonNo: number, readonly roundNo: number) {
    super(`race already settled: ${lobbyId} s${seasonNo}r${roundNo}`);
    this.name = 'AlreadySettledError';
  }
}

/**
 * Ödemenin tek kapısı.
 *
 * Testin araya girip yarım bir muhasebe üretebilmesi için enjekte edilebilir:
 * "bir şey ortada patlarsa hiç RP yazılmaz" iddiası ancak gerçekten ortada bir
 * şey patlatılarak kanıtlanabilir. Üretimde varsayılan her zaman `addRp`tir.
 */
export interface SettleDeps {
  addRp: (client: PoolClient, lobbyId: string, teamKey: string, amount: number) => Promise<void>;
}

const defaultDeps: SettleDeps = { addRp };

/**
 * Yarışı muhasebeleştirir: tabloyu üretir ve her koltuğa RP yazar.
 *
 * TEK İŞLEM: `markSettled` ile bütün alacaklandırmalar aynı transaction'da.
 * Ortada herhangi bir şey patlarsa muhasebe kaydı da RP de geri alınır, yani
 * yarış hâlâ ödenmemiş sayılır ve yeniden denenebilir. Ayrı işlemlerde
 * olsalardı iki kötü sondan biri kesin olurdu: ya ödemesiz bir muhasebe kaydı
 * (yarış BİR DAHA ASLA ödenemez) ya da kayıtsız bir ödeme (her yeniden
 * oynatmada tekrar ödenir).
 *
 * `AlreadySettledError` fırlatır: bu yarış daha önce ödendi.
 *
 * `client` VERİLİRSE (Faz 3a-2 süpürme döngüsü): yazmalar ÇAĞIRANIN
 * işleminde yapılır, burada yeni bir `withTransaction` AÇILMAZ. Bunun
 * nedeni `runner.ts`teki bayrak anı — koşu satırının `finished_at`ı ve lobi
 * evresinin `result`e geçmesi, ödemeyle AYNI taahhütte olmalı. İkisi ayrı
 * işlemlerde olsaydı arada çöken bir süreç "bitmiş ama hiç ödenmemiş" bir
 * yarış bırakırdı — bu görevin asıl düzelttiği hata. `client` verilmediğinde
 * (testler, doğrudan çağrılar) davranış öncekiyle birebir aynı: fonksiyon
 * kendi işlemini açar ve kapatır.
 */
export async function settleRace(
  input: SettleRaceInput,
  deps: SettleDeps = defaultDeps,
  client?: PoolClient,
): Promise<RaceSettlement> {
  const { lobbyId, seasonNo, roundNo, now } = input;

  const run = await loadRun(lobbyId, seasonNo, roundNo);
  if (!run) {
    throw new Error(`settleRace: no race run for ${lobbyId} s${seasonNo}r${roundNo}`);
  }
  const decisions = await loadDecisions(lobbyId, seasonNo, roundNo);
  // `uptoLap` verilmiyor: muhasebe her zaman BAYRAĞA kadar oynatır. Yarı
  // yolda bir yarışın sonucu diye bir şey yoktur.
  const state = replayRace({ seed: run.seed, round: roundNo, snapshot: run.snapshot, decisions });
  if (!state.finished) {
    throw new Error(`settleRace: race did not reach the flag for ${lobbyId} s${seasonNo}r${roundNo}`);
  }
  const result = finishRace(state);

  // Tablo AYRI SAKLANMAZ; yarışın kendisi gibi tariften türetilir (bkz.
  // runner.ts `standingsBeforeRound`). Burada üretilen tablo, bir sonraki
  // turun tarifine giren tablonun aynısıdır — iki yol da aynı yeniden
  // oynatmadan çıktığı için ayrışamazlar.
  const standings = result.standings;
  const positionOf = new Map(standings.map((s) => [s.teamKey, s.position]));

  const economies = await loadLobbyEconomy(lobbyId);
  const seats = await loadSeats(lobbyId);

  // Brifing, tarifin DONDURULMUŞ katılımından okunur — asla yeniden
  // hesaplanmaz, asla oyuncudan istenmez. Pist ve hava tarifin kendisinden
  // (tohum + tur), araç ayarı/taktik/sıralama riski `RaceSnapshot.entries` ve
  // `.risks`ten gelir: ışıklar sönerken `runner.ts`in `startRaceFor`ı
  // `loadWeekendChoices`i TEK SEFER okuyup oraya donduruyor. AI'nın koltuğu
  // `entries`e hiç girmediği için (yarışı hiç "seçmedi") o takım brifing
  // bonusuna giremez — sponsorluk ve yarış ödülü gibi ekonomiye değil,
  // BİR KARARA bağlı bir gelir kolu bu.
  const track = trackForRound(roundNo);
  const weather = weatherFor(track, run.seed);

  /**
   * Bir takımın yarış GÜNÜ bitişi: sponsor hedefi ve seri BUNA göre yargılar,
   * şampiyona tablosundaki (kümülatif puan) sırasına göre DEĞİL. İstemcinin
   * kendi arabası için yaptığı kuralın (gameStore.ts `settleRaceWeekend`
   * `judged`) her koltuğa genellemesi: iki sürücüden daha iyi sıradaki
   * (bitirmeyen sayılmaz), ikisi de bitirmediyse sahanın tam iki katı — yani
   * hiçbir geçerli hedef (en fazla P12) onu asla tutturamaz.
   */
  const teamRaceFinish = (order: FinishEntry[], teamKey: string): number => {
    const classified = order.filter((e) => e.teamKey === teamKey && !e.dnf).map((e) => e.position);
    return classified.length ? Math.min(...classified) : standings.length * 2;
  };

  // Yazma gövdesi bir kapanışta: `client` ÇAĞIRANDAN geldiyse onun üzerinde
  // çalışır ve `withTransaction`ı hiç görmez (commit/rollback çağıranın
  // işidir — bkz. `runner.ts` `flag()`); verilmediyse eskisi gibi kendi
  // işlemini kendisi açar. İki yol da AYNI gövdeyi çalıştırır, yani "kim
  // taahhüt eder" dışında davranışları ayrışamaz.
  const writePayouts = async (c: import('pg').PoolClient): Promise<RaceSettlement> => {
    // ÖNCE KAPI: ödeme yazmalarıyla AYNI işlemde ve yazmalardan önce.
    if (!(await markSettled(c, lobbyId, seasonNo, roundNo, now))) {
      // FIRLAT, DÖNME. Dönmek buraya kadar yazılanları taahhüt ederdi; burada
      // henüz bir şey yazılmamış olsa bile kural aynı kalmalı, çünkü bu satırın
      // altına ileride bir yazma eklenmesi yeterdi.
      throw new AlreadySettledError(lobbyId, seasonNo, roundNo);
    }

    // Personel sözleşmeleri: BİR YARIŞ TURU SETTLE OLDUĞUNDA bir kez iner.
    // `markSettled` kapısından SONRA, aynı işlemde — ikinci bir muhasebe
    // buraya HİÇ ulaşmaz (yukarıdaki `throw` onu daha bu satıra gelmeden
    // durdurur), yani bu tik doğal olarak İDEMPOTENTTİR: settle etmeyi iki
    // kez denemek sözleşmeyi bir kez indirir.
    await tickStaffContracts(c, lobbyId);

    // Bir sonraki turun BAŞINDA hangi sözleşmeler düşer: istemcinin kendi
    // kuralı (gameStore.ts `settleRaceWeekend`, `sponsorships.filter((s) =>
    // s.expiresRound > nextRound)`) burada da BİREBİR aynı — bir tur erken
    // düşürmek oyuncuyu son ödemesinden mahrum bırakır, bir tur geç düşürmek
    // slotu bir tur fazla kilitli tutar.
    const nextRound = roundNo + 1;

    // Rolled BEFORE the per-seat payout loop (rather than after, where it
    // used to live) so each seat's own settlement row can be written WITH
    // its rival-espionage result in the same insert — see `SeatPayout`'s and
    // `insertSettlementPayout`'s own doc comments for why splitting the two
    // into a separate write would leave the effect applied with no record
    // reachable by any screen. Once per settled race, per human seat — see
    // `runRivalEspionage`'s own docblock for why this lives at settlement
    // rather than on a timer or a claim.
    const rivalResults = await runRivalEspionage(
      c, lobbyId, seasonNo, roundNo, seats, positionOf, economies.map((e) => e.teamKey),
    );

    // ── Başarımlar + kariyer (bkz. `weekendAchievements.ts`'in kendi
    // docblock'u) ────────────────────────────────────────────────────────────
    // Sıralama ve pratik BİR KEZ, bütün koltuklar için ORTAK türetilir —
    // yalnızca `teamKey`e göre BAKILAN dilim koltuktan koltuğa değişir
    // (`weekendAchievements.ts` `teamGridSlots`/`buildPracticeTuple`).
    // `qualifyingForRecipe` tarifin (tohum + snapshot) SAF bir fonksiyonu,
    // `replayRace`in zaten içeride bir kez hesapladığı AYNI ızgarayı üretir
    // (bkz. o dosyanın kendi docblock'u) — burada ikinci bir yarış koşulmaz.
    const qualifying = qualifyingForRecipe({ seed: run.seed, round: roundNo, snapshot: run.snapshot });
    // AYNI BAĞLANTI: `loadPracticeRuns` işlemin ORTASINDA çağrılıyor, `c`
    // verilmezse havuzdan ikinci bir bağlantı istemek kilitlenebilirdi
    // (bkz. dosyanın başındaki "AYNI BAĞLANTI" notları).
    const practiceRuns = await loadPracticeRuns(lobbyId, seasonNo, roundNo, c);
    const sessionCount = practiceCount(track.sprint);
    const practiceSessions: (TimedEntry[] | undefined)[] = [];
    for (let i = 1; i <= sessionCount; i += 1) {
      const found = practiceRuns.find((r) => r.sessionNo === i);
      practiceSessions.push(found ? derivePracticeResult(found).order : undefined);
    }
    const seatByTeam = new Map(seats.map((s) => [s.teamKey, s]));

    const payouts: SeatPayout[] = [];
    for (const econ of economies) {
      // Ekonomi satırı olan ama tabloda olmayan bir takım olamaz (tablo 11
      // takımın hepsini taşır); yine de sessiz bir `undefined` yerine sahanın
      // sonunu varsayıyoruz — ödül merdiveninin en ucuzu.
      const position = positionOf.get(econ.teamKey) ?? standings.length;
      // Sayı UYDURULMAZ: yarış günü ödülü `shared/src/sponsors.ts` `racePrize`
      // merdiveninden okunur ve o da `ECONOMY_SCALE`e bağlıdır — ekonominin tek
      // knob'u. `prize` ayrıca DÖKÜME de gider — `rp`nin içine gömülüp
      // kaybolmaz, ekranın "yarış ödülü" satırı buradan okur.
      const prize = racePrize(position, standings.length);
      let rp = prize;
      let sponsorIncome = 0;
      let bonusesEarned: string[] = [];
      let streaksBroken: string[] = [];
      const expiredSlots: string[] = [];

      // Sponsorluk geliri: HER aktif sözleşme perRace'ini öder, hedefi
      // tutturan da bonus+seri kazanır — formül `shared/src/sponsors.ts`
      // `settleRace`ten, burada TEKRARLANMAZ. Aynı bağlantı (`c`) kullanılır:
      // aksi halde havuzdan ikinci bir bağlantı istemek, bu bağlantı zaten
      // işlemin ortasındayken kilitlenebilirdi.
      const sponsorships = await loadTeamSponsorships(lobbyId, econ.teamKey, c);
      if (sponsorships.length > 0) {
        const finish = teamRaceFinish(result.order, econ.teamKey);
        const sponsorResult = settleSponsorships(sponsorships, finish);
        sponsorIncome = sponsorResult.income;
        rp += sponsorIncome;
        bonusesEarned = sponsorResult.bonusesEarned;
        streaksBroken = sponsorResult.streaksBroken;

        // Seri KALICI olmalı, yoksa bir sonraki yarış küflü veriden öder
        // (bu görevin düzelttiği tam da bu). Süresi bu turun sonunda dolan
        // sözleşme tamamen kaldırılır — istemcinin kuralıyla aynı; kalanların
        // serisi yazılır.
        const expiring = new Set<string>();
        for (const s of sponsorResult.sponsorships) {
          if (s.expiresRound <= nextRound) {
            expiring.add(s.dealId);
            // Döküme giren liste BU liste: silinen pozisyonların kendisi.
            // Ayrı bir "hangileri dolmuştu" sorgusu, silmeden sonra artık
            // cevaplanamaz bir soru olurdu.
            expiredSlots.push(s.slot);
          } else {
            await setStreak(c, lobbyId, econ.teamKey, s.slot, s.streak);
          }
        }
        for (const dealId of expiring) {
          await deleteDeal(c, lobbyId, econ.teamKey, dealId);
        }
      }

      // Brifing bonusu: yalnız bu koltuk için gerçek bir "hafta sonu seçimi"
      // varsa (AI'da yok). Doğruluk her zaman 1 — istemcinin ödeme anında
      // yaptığı gibi (gameStore.ts `settleRaceWeekend`), yani zayıf bir
      // stratejistin YANLIŞ çağrısını izlemek hiçbir şey kazandırmaz.
      let briefBonus = 0;
      // `weekendAchievements.ts`'in `briefFollowed`ine giden HAM sayı (RP'ye
      // çevrilmeden önceki uyum adedi) — `scoreWeekend`in kendi `BRIEF_SCORE_
      // EACH`i `settle.ts`'in `BRIEF_RP_EACH`inden AYRI bir sabit (kariyer skoru
      // RP değildir), o yüzden burada çarpılmadan taşınır.
      let briefFollowed: number | undefined;
      const entry = run.snapshot.entries[econ.teamKey];
      if (entry) {
        // Brifing, ışıklar sönerken DONMUŞ stratejist parametreleriyle
        // (`run.snapshot.briefParams`) okunur — settlement anındaki kadro
        // BURADA HİÇ SORULMAZ. Parametre yoksa (o an stratejist yoktu)
        // `briefFor`in kendi varsayılanları (doğruluk 1, bant 0.05) devreye
        // girer, yani bugünkü davranışın birebir aynısı kalır.
        const params = run.snapshot.briefParams?.[econ.teamKey];
        const items = params
          ? briefFor(track, weather, entry.setup, params.accuracy, 0, params.forecastBand)
          : briefFor(track, weather, entry.setup);
        const choices: WeekendChoices = {
          raceCompound: entry.setup.compound,
          tactics: entry.tactics,
          risk: run.snapshot.risks[econ.teamKey] ?? 'safe',
          bias: entry.setup.bias ?? 0,
        };
        briefFollowed = briefCompliance(items, choices);
        briefBonus = briefFollowed * BRIEF_RP_EACH;
        rp += briefBonus;
      }

      await deps.addRp(c, lobbyId, econ.teamKey, rp);
      const rival = rivalResults.get(econ.teamKey);

      // ── Bu koltuğun hafta sonu başarımları + (varsa) kariyeri ────────────
      // Yalnızca SAHİPLİ koltuk (`user_id` dolu — insan ya da asistanla
      // sürülen; `lobby_seats_owner_check`, 002_lobby.sql): AI koltuğunun
      // arkasında bir kullanıcı yok, kariyer KULLANICIYA ait olduğu için
      // yazacak kimse yok (bkz. `013_career.sql`'in kendi notu).
      const seat = seatByTeam.get(econ.teamKey);
      let achievementsEarned: AchievementKey[] = [];
      let careerScore = 0;
      if (seat?.userId) {
        const weekend = scoreSeatWeekend({
          race: result,
          qualifyingGrid: qualifying.grid,
          practiceSessions,
          sprint: track.sprint,
          briefFollowed,
        }, econ.teamKey);
        achievementsEarned = weekend.earned;
        careerScore = weekend.score;
        // AYNI İŞLEM: kariyer okuma-yaz-satırı (`for update` kilidiyle) da bu
        // transaction'ın parçası — `markSettled` kapısından SONRA, `addRp`yle
        // birlikte. Ortada bir şey patlarsa RP nasıl geri alınıyorsa kariyer
        // de öyle geri alınır; ikinci bir muhasebe (`AlreadySettledError`)
        // buraya HİÇ ulaşmaz, yani kariyer de tıpkı RP gibi YALNIZCA BİR KEZ
        // ilerler.
        const career = await loadCareerForUpdate(c, seat.userId);
        const nextCareer = recordSeatWeekend(career, weekend, result, econ.teamKey);
        await saveCareer(c, seat.userId, nextCareer);
      }
      // AYNI BAĞLANTI, AYNI İŞLEM: döküm `markSettled` kapısından SONRA ve
      // `addRp`yle TAM OLARAK aynı taahhütte yazılır (bkz. `settlementRepo.ts`
      // docblock'u) — ortada bir şey patlarsa ikisi birlikte geri alınır,
      // parasız bir kayıt ya da kayıtsız bir ödeme çıkmaz. Rival-espionage
      // sonucu da AYNI satıra, AYNI yazmayla girer — `bumpCarStat`'ın rakip
      // takımın arabasına uyguladığı etki de bu transaction'ın parçası, yani
      // ortada bir şey patlarsa etki de kayıt da BİRLİKTE geri alınır.
      await insertSettlementPayout(c, lobbyId, seasonNo, roundNo, {
        teamKey: econ.teamKey, position, prize, sponsorIncome, briefBonus, bonusesEarned, streaksBroken,
        expiredSlots, rivalSpyTeam: rival?.team, rivalSpySuccess: rival?.success,
        achievementsEarned, careerScore,
      });
      payouts.push({
        teamKey: econ.teamKey, position, rp, prize, sponsorIncome, briefBonus, bonusesEarned, streaksBroken,
        expiredSlots, achievementsEarned, careerScore,
      });
    }

    return { standings, payouts };
  };

  return client ? writePayouts(client) : withTransaction(writePayouts);
}
