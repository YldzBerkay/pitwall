/**
 * Lobi yarışının SAF yeniden oynatması.
 *
 * NEDEN bit düzeyinde aynı olmak zorunda:
 *
 * Yarış durumunu saklamıyoruz; onu üreten TARİFİ saklıyoruz — tohum, ışıklar
 * söndüğünde dondurulan katılımlar (`RaceSnapshot`) ve her pit kararının hangi
 * turda verildiğini yazan karar günlüğü. Yarış motoru deterministik:
 * `advanceLap` rastgeleliğini `(seed, round, lap)` üçlüsünden çekiyor, taşınan
 * değişken bir durumdan değil. Bu yüzden tarifi yeniden oynatmak birebir aynı
 * yarışı verir.
 *
 * Üç şey buna dayanıyor:
 *  1. Kullanıcının şartı: herkes AYNI yarışı görmeli — kimse farklı bir sonuç
 *     görmemeli. Tarif tek olduğu sürece yarış da tektir.
 *  2. Geç katılan istemci: 40. turda bağlanan bir oyuncuya, o ana kadarki
 *     gerçek durum yeniden oynatılarak gösterilir.
 *  3. Çöken sunucu: yarışın ortasında yeniden başlayan süreç, karar
 *     günlüğünden aynı yere geri döner.
 *
 * Bu modül SAFtır: veritabanı yok, saat yok, `Math.random()` yok. Çağıran her
 * şeyi verir.
 *
 * TUR SÖZLEŞMESİ (Görev 8 — pit uç noktası — aynısını yazmak zorunda):
 *   `lap: N` olan bir karar, N. turu simüle eden `advanceLap` çağrısına
 *   verilir; yani `state.lap === N - 1` iken yapılan çağrıya. Başka bir
 *   deyişle N, kararın ETKİ ETTİĞİ tur — sürücünün N. turda pite girdiği tur.
 *   Dolayısıyla canlı yarışta `state.lap === L` iken alınan bir pit çağrısı
 *   `lap: L + 1` olarak yazılır: koşulacak ilk tur odur.
 *   `uptoLap: L` ile oynatma, `lap <= L` olan kararları uygular; daha
 *   ilerideki kararlar görmezden gelinir.
 *
 * SINIR DAVRANIŞI (kasıtlı, kazara değil — çağıran buna güvenebilir):
 *   - `uptoLap` verilmezse yarış bayrağa kadar koşar.
 *   - `uptoLap <= 0`: tur döngüsü hiç dönmez, ızgara durumu (lap 0) döner.
 *   - `uptoLap > track.laps`: bitmiş yarışa kırpılır.
 *   - `uptoLap` kesirliyse aşağı yuvarlanır (`lap <= 40.7` → 40. tur).
 *   - `uptoLap` sayı DEĞİLSE ya da sonlu değilse (NaN/Infinity) FIRLATIR.
 *     NEDEN: `Math.min(NaN, laps)` NaN'dır, döngü hiç dönmez ve fonksiyon
 *     "lap 0" durumunu sanki geçerli bir yarışmış gibi döndürürdü. NaN yalnız
 *     bozuk bir DB okumasından ya da aritmetik hatadan gelebilir; o durumda
 *     çağıran bütün istemcilere "bu yarış 0. turda" yayınlar. Sessizce makul
 *     görünen bir yanlış yerine gürültülü bir hata seçiyoruz.
 *   - Günlükteki ÇÖPLÜ satırlar (lap <= 0, tanınmayan `teamKey`, 0/1 dışında
 *     `driverIdx`) sessizce yok sayılır. Bu da bir karar: günlük ekleme-only ve
 *     değişmez, tek bozuk satır koşan bir yarışı tuğlaya çeviremez. (Motor
 *     zaten yalnızca insan yönetimli, tanıdığı anahtarların kararını okur.)
 *
 * TAKMA AD (aliasing) UYARISI: `startRace` `entries`, `standings` ve `rosters`u
 * REFERANSLA saklar, yani dönen `RaceState` çağıranın snapshot'ını paylaşır
 * (`state.entries === snapshot.entries`). `replayRace` bunların hiçbirini
 * değiştirmediği için bugün sorun yok; ama akışın ilerisinde bir şey
 * (ödeme/settlement, WebSocket serileştirici) `state.entries` veya
 * `state.standings` üzerinde mutasyon yaparsa tarifi bozar ve SONRAKİ her
 * yeniden oynatma farklı bir yarış üretir. Mutasyon gerekiyorsa önce kopyala.
 */
import {
  advanceLap,
  simulateQualifying,
  startRace,
  weatherFor,
  type AiBonus,
  type Decisions,
  type Entries,
  type PitLaneStart,
  type QualifyingResult,
  type QualiRisk,
  type RaceState,
  type Rosters,
} from '@pitwall/shared/raceEngine';
import { trackForRound } from '@pitwall/shared/tracks';
import type { CompoundKey } from '@pitwall/shared/carCustomisation';
import type { TeamStanding } from '@pitwall/shared/teams';

/** Işıklar söndüğünde dondurulan her şey. Yarış boyunca değişmez. */
export interface RaceSnapshot {
  entries: Entries;
  risks: Record<string, QualiRisk>;
  standings: TeamStanding[];
  aiBonus: AiBonus;
  rosters: Rosters;
  /**
   * Parc fermé cezası: grid yerini kaybedip pit yolundan başlayan araçlar
   * (`takım:sürücü`). TARİFİN parçası olmak ZORUNDA, çünkü yeniden oynatma
   * anında HESAPLANAMAZ: ceza `evaluateParcFerme`nin `pending_jobs`u ışıklar
   * söndüğü ANDAKİ saate göre okumasından doğar ve o işler bu arada teslim
   * alınmış olabilir. Taşınmazsa aynı tohum cezalıları ızgaraya geri dizer —
   * yani oyuncuların izlediğinden BAŞKA bir yarış.
   *
   * İSTEĞE BAĞLI, çünkü bu alandan önce yazılmış tarifler onsuz duruyor;
   * verilmediğinde `startRace` bugünkü davranışının aynısını üretir.
   */
  pitLaneStarts?: Record<string, PitLaneStart>;
}

/** Günlüğe yazılan tek bir pit kararı. `lap`: kararın etki ettiği tur. */
export interface DecisionLogEntry {
  lap: number;
  teamKey: string;
  driverIdx: 0 | 1;
  compound: CompoundKey;
}

export interface ReplayInput {
  seed: number;
  round: number;
  snapshot: RaceSnapshot;
  decisions: readonly DecisionLogEntry[];
  /** Bu tura kadar oynat. Verilmezse yarış bitene kadar koşar. */
  uptoLap?: number;
}

/**
 * Karar günlüğünün bir turluk dilimini motorun `Decisions` haritasına çevirir.
 *
 * DIŞA VERİLİYOR çünkü yarış koşucusu durumu bellekte tutup tur tur ilerletecek
 * (her tikte baştan oynatmak savurganlık olurdu) ve o döngünün `advanceLap`e
 * verdiği harita ile buradaki yeniden oynatmanın verdiği harita ASLA
 * ayrışmamalı. Anahtar biçimi (`takım:sürücü`) ve tur sözleşmesi tek yerde
 * dursun diye `replayRace` de bu yardımcıyı kullanır.
 *
 * Aynı (tur, takım, sürücü) için İKİNCİ bir girdi olamaz: `004_race.sql`,
 * `race_decisions` tablosuna `(lobby_id, season_no, round_no, lap, team_key,
 * driver_idx)` birincil anahtarını koyar, yani veritabanı aynı araç için aynı
 * turda ikinci kararı reddeder — İLK karar geçerlidir. Bu, yeniden oynatmanın
 * deterministik olmasının koşulu: günlük değişmez olmalı. Tekrarlar mümkün
 * OLSAYDI günlüğün sırası sonucu belirlerdi, dolayısıyla "sıra önemsiz" ile
 * "sonraki öncekini ezer" aynı anda doğru olamaz. Burada yine de ilk girdiyi
 * koruyoruz ki davranış şemanın sözleşmesiyle birebir örtüşsün.
 */
export function decisionsForLap(decisions: readonly DecisionLogEntry[], lap: number): Decisions {
  const out: Decisions = {};
  for (const d of decisions) {
    if (d.lap !== lap) continue;
    if (d.driverIdx !== 0 && d.driverIdx !== 1) continue;
    const key = `${d.teamKey}:${d.driverIdx}`;
    if (key in out) continue; // İlk karar geçerli — bkz. yukarıdaki değişmezlik.
    out[key] = { compound: d.compound };
  }
  return out;
}

/** `qualifyingForRecipe`nin girdisi: tarifin ızgarayı belirleyen kısmı. */
export type QualifyingRecipe = Pick<ReplayInput, 'seed' | 'round' | 'snapshot'>;

/**
 * Tarifin sıralama turlarını üretir.
 *
 * NEDEN AYRI VE DIŞA AÇIK: `replayRace` ızgarayı kurmak için bu hesabı zaten
 * yapıyordu, sonucu (grid dışında) ATIYORDU. Sıralama sonucu da tıpkı yarış
 * durumu gibi SAKLANMAZ — tarifin (`seed`, `round`, `snapshot`) SAF bir
 * fonksiyonu olduğu için her zaman yeniden türetilebilir ve her türetme aynı
 * sonucu verir. Bunu tek, dışa açık bir fonksiyona çıkarmak iki şeyi sağlıyor:
 *  1. Bir istemciye ızgarayı göstermek için yarış durumunu hiç kurmaya gerek
 *     yok (bkz. `lobby/live.ts` — `state` çerçevesi bunu taşır).
 *  2. `replayRace` artık bunu ÇAĞIRIYOR, kendi kopyasını tutmuyor — iki hesap
 *     birbirinden ayrışamaz.
 *
 * SAF: veritabanı yok, saat yok, `Math.random()` yok — rastgelelik yalnızca
 * `seed`ten geliyor. Bu yüzden "herkes aynı ızgarayı görür" burada da
 * yapısal, aksiyomatik değil.
 */
export function qualifyingForRecipe(input: QualifyingRecipe): QualifyingResult {
  const { seed, round, snapshot } = input;
  const track = trackForRound(round);
  const weather = weatherFor(track, seed);
  return simulateQualifying({
    track,
    entries: snapshot.entries,
    risks: snapshot.risks,
    wet: weather.wetAtStart,
    round,
    seed,
    aiBonus: snapshot.aiBonus,
    rosters: snapshot.rosters,
  });
}

/**
 * Tarifi yarışa çevirir. Aynı girdi her zaman aynı `RaceState`i verir.
 */
export function replayRace(input: ReplayInput): RaceState {
  const { seed, round, snapshot, decisions } = input;
  const track = trackForRound(round);
  const weather = weatherFor(track, seed);

  // Sıralama turları başlangıç gridini belirler — grid değişirse bütün yarış
  // değişir. `risks` bu yüzden tarifin parçası, süs değil. Hesap artık
  // `qualifyingForRecipe`de yaşıyor ki sonucu ayrıca çekmek isteyen (canlı
  // yayının `state` çerçevesi gibi) ikinci bir kopya hesaplamasın.
  const qualifying = qualifyingForRecipe({ seed, round, snapshot });

  let state = startRace({
    standings: snapshot.standings,
    track,
    entries: snapshot.entries,
    weather,
    grid: qualifying.grid,
    round,
    seed,
    aiBonus: snapshot.aiBonus,
    rosters: snapshot.rosters,
    // Ceza gridi KURARKEN uygulanır (araç sahanın arkasına alınır, üstüne pit
    // yolu transiti biner), sonradan düzeltilemez — bu yüzden burada.
    pitLaneStarts: snapshot.pitLaneStarts,
  });

  // NaN/Infinity gürültüyle patlasın: sessizce 0. turda duran bir yarış,
  // bütün istemcilere yayınlanacak makul görünen bir yalandır.
  if (input.uptoLap !== undefined && !Number.isFinite(input.uptoLap)) {
    throw new Error(`replayRace: uptoLap sonlu bir sayı olmalı, gelen: ${input.uptoLap}`);
  }

  const lastLap = input.uptoLap === undefined ? track.laps : Math.min(input.uptoLap, track.laps);
  for (let lap = state.lap + 1; lap <= lastLap; lap += 1) {
    if (state.finished) break;
    // Koşucunun tik döngüsüyle AYNI yardımcı — iki kopya olsa ayrışabilirlerdi.
    state = advanceLap(state, track, decisionsForLap(decisions, lap));
  }
  return state;
}
