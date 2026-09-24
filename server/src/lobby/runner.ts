/**
 * Yarış koşucusu — ışıklar söndüğü an.
 *
 * NE YAPAR: lobinin o anki gerçeğini (kim koltukta, kim check-in yaptı, hangi
 * araç, hangi açık iş) tek bir TARİFE çevirir ve `race_runs`a bir kez yazar.
 * Tur döngüsü burada YOKTUR; onu tüketen koşucu sonraki adımın işidir.
 *
 * NEDEN TARİF, NEDEN DURUM DEĞİL:
 * Kullanıcının tek şartı "herkes aynı yarışı görmeli". Yarış durumunu saklamak
 * bu şartı sağlamaz — saklanan durum bir sürecin belleğinden gelir ve iki
 * süreç iki durum üretebilir. Motor deterministik olduğu için (bkz.
 * `replay.ts`) tarif tekse yarış da tektir: tohum + dondurulmuş katılım +
 * değişmez karar günlüğü. Bu modül o tarifin İLK iki parçasını yazar.
 *
 * NEDEN HER ŞEY BURADA DONAR:
 * Katılımı yarış sırasında yeniden okumak (örneğin "şu an check-in yapmış mı"
 * diye sormak) tarifi zamana bağlı kılardı: geç check-in yapan bir oyuncu,
 * daha önce oynatılmış turları GERİYE DÖNÜK değiştirirdi. Bu yüzden karar bir
 * kez, burada verilir ve `snapshot` içinde taşlaşır.
 *
 * `now` HER ZAMAN çağırandan gelir; bu modül saati asla kendisi okumaz
 * (server/README.md §"now sadece route'ta örneklenir"). Parc fermé'nin "iş
 * bitti mi" sorusu da aynı `now`a bakar, yani tek bir ana göre karar verilir.
 */
import {
  advanceLap,
  crippleSetup,
  finishRace,
  weatherFor,
  CRIPPLED_DNF_SCALE,
  type CarSetup,
  type Entries,
  type PitLaneStart,
  type QualiRisk,
  type RaceState,
  type TacticPreset,
  type WeatherPlan,
} from '@pitwall/shared/raceEngine';
import type { CompoundKey } from '@pitwall/shared/carCustomisation';
import { trackForRound } from '@pitwall/shared/tracks';
import { freshStandings } from '@pitwall/shared/season';
import type { TeamStanding } from '@pitwall/shared/teams';
import { query, withTransaction } from '../db/pool.ts';
import { loadLobbyEconomy } from '../economy/repo.ts';
import { settleRace, type SettleDeps } from '../economy/settle.ts';
import { renewLease, releaseLease } from './lease.ts';
import { loadSeats } from './lobbyRepo.ts';
import { evaluateParcFerme } from './parcFerme.ts';
import { advanceLastLap, finishRun, loadDecisions, loadRun, startRun } from './raceRepo.ts';
import { decisionsForLap, replayRace, type DecisionLogEntry, type RaceSnapshot } from './replay.ts';
import { loadWeekendChoices } from './weekendChoices.ts';

export interface StartRaceInput {
  lobbyId: string;
  seasonNo: number;
  roundNo: number;
  now: Date;
}

export interface StartedRace {
  seed: number;
  snapshot: RaceSnapshot;
}

/**
 * Hafta sonu seçimleri (setup bileşimi, taktik, sıralama yaklaşımı) artık
 * `lobby_seats`te saklanıyor (006_weekend_choices.sql,
 * `./weekendChoices.ts` `loadWeekendChoices`). Aşağıdaki sabitler seçim
 * YOKKEN düşülecek varsayılanlar olarak kalır — bir koltuk hiçbir zaman bir
 * seçim göndermemiş olabilir ve yine de yarışmak ZORUNDADIR (seçimler
 * OPSİYONELDİR). Varsayılanlar tarife YAZILDIĞI için bugünkü yarışlar da
 * yarınki kodla aynı şekilde oynatılır.
 */
const DEFAULT_COMPOUND: CompoundKey = 'MEDIUM';
const DEFAULT_TACTICS: TacticPreset = 'balanced';
const DEFAULT_RELIABILITY = 0.3;
const DEFAULT_RISK: QualiRisk = 'safe';

/**
 * Güvenilirlik OYUNCU SEÇİMİ DEĞİLDİR — `lobby_seats`e hiç yazılmaz — fabrika
 * seviyelerinden türetilir.
 *
 * NEDEN `factoryEffects` KULLANILMIYOR: `shared/src/factory.ts`in
 * `factoryEffects`i altı alan döndürür (upgradeGainBonus, upgradeCostScale,
 * upgradeTimeScale, trainingScale, forecastScale, winterFloorBonus) ve
 * hiçbiri güvenilirlikle ilgili değildir. Yalnızca `factoryDepartments`in
 * KENDİ AÇIKLAMA METNİ ("ENGINE LAB" → "Güvenilirlik +0,02" seviye başına)
 * bu etkiyi anlatır; sayı hiçbir hesaba girmiyordu. Silinmiş istemci kodu
 * bunun yerine ham bir formül kullanıyordu, `min(1, (manufacturing +
 * engine_lab)/10 + bonus)` — burada TEKRARLANMIYOR, çünkü `manufacturing`in
 * belgelenen tek etkisi maliyet/süredir (`factoryEffects.upgradeCostScale`/
 * `upgradeTimeScale`), güvenilirlikle ilişkilendirilmesi şemaya hiç girmeyen
 * bir sayı icat etmek olurdu. Bunun yerine `factoryDepartments`in belgelediği
 * TEK sayı kullanılıyor: her ENGINE LAB seviyesi `DEFAULT_RELIABILITY`
 * üzerine +0,02 ekler.
 *
 * IŞIKLAR SÖNERKEN TEK SEFER OKUNUR: `startRaceFor` bu fonksiyonu yalnızca
 * tarifi kurarken çağırır ve sonucu `entries`e donar — bir sonraki fabrika
 * yükseltmesi zaten koşmuş bir yarışın güvenilirliğini değiştirmez.
 */
const RELIABILITY_PER_ENGINE_LAB_LEVEL = 0.02;
function reliabilityFor(factoryLevels: Record<string, number | undefined>): number {
  const engineLab = Math.max(0, factoryLevels['engine_lab'] ?? 0);
  return Math.min(1, DEFAULT_RELIABILITY + engineLab * RELIABILITY_PER_ENGINE_LAB_LEVEL);
}

/**
 * Tohumun `(seasonNo, roundNo, lobbyId)` üçlüsünden türetilmesi.
 *
 * NEDEN TÜRETME YETMEZ, TOHUM SAKLANIR:
 * Saklanan tohum OTORİTERDİR; türetme yalnızca ilk kez, `race_runs` satırı
 * yazılırken kullanılır. Yeniden oynatan hiçbir yol bu fonksiyonu çağırmaz,
 * `loadRun().seed`i okur. Dolayısıyla buradaki formül ileride değişirse (daha
 * iyi dağılım, lobiye özel bir tuz, ne olursa) ESKİ yarışlar hâlâ birebir aynı
 * oynatılır — değişiklik yalnızca o andan sonra başlayan yarışları etkiler.
 * Formülü "kararlı" kılan şey değişmezliği değil, saklanıyor olmasıdır.
 *
 * NEDEN LOBİ KİMLİĞİ DE GİRER: aynı sezon/turda koşan iki lobi aynı tohumu
 * alsaydı iki ayrı ligin hava durumu, sıralama gürültüsü ve yarış olayları
 * birebir aynı olurdu.
 *
 * 32 BİT SINIRI: `race_runs.seed` `integer` ve motorun RNG'si `seed >>> 0` ile
 * zaten 32 bite kırpıyor (shared/src/rng.ts). Sonucu 31 bitle maskeliyoruz ki
 * değer Postgres'in İŞARETLİ `integer` aralığına (0..2147483647) garanti
 * sığsın — negatif bir tohum da çalışırdı ama saklanan değerle RNG'nin gördüğü
 * değer arasında gereksiz bir dönüşüm bırakırdı.
 */
export function deriveSeed(lobbyId: string, seasonNo: number, roundNo: number): number {
  // FNV-1a: kısa, bağımlılıksız ve uuid'in her karakterini sonuca karıştırır.
  let h = 0x811c9dc5;
  for (const ch of `${lobbyId}:${seasonNo}:${roundNo}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) & 0x7fffffff;
}

/**
 * Pit yolundan başlayan aracın SERBEST başlangıç lastiği.
 *
 * NEDEN DOLDURULMAK ZORUNDA: `parcFerme.ts` her cezalı araç için boş bir nesne
 * üretir — "ceza var, lastik henüz seçilmedi". Boş kalırsa motor
 * `setup.compound`a düşer ve oyuncu SAF ceza yer: grid yerini kaybeder, pit
 * yolu transitini öder, karşılığında hiçbir şey almaz. Gerçek F1'de takımlar
 * bu cezayı bazen BİLEREK alır, çünkü karşılığında sınırsız setup ve serbest
 * başlangıç lastiği vardır. Telafiyi düşürmek mekaniği tersine çevirir.
 *
 * NEDEN BU SEÇİM:
 *  - Kuru pistte HARD. Pit yolundan çıkan araç sahanın arkasında, temiz
 *    havada ve uzun bir ilk stint koşmak zorunda; HARD tur başına ~0.5 sn
 *    veriyor ama aşınması MEDIUM'un üçte iki katı, yani stint belirgin uzuyor.
 *    Serbest lastiğin tek gerçek değeri budur: strateji kaydırma.
 *  - Islak pistte WET. Islakta "serbest seçim" bir avantaj değil, bir
 *    zorunluluktur; INTERMEDIATE daha hızlı aşınır ve tur başına daha yavaştır.
 *    Sahanın AI'sı da ıslakta WET kullanır, yani araç en azından doğru lastikle
 *    yarışa katılır.
 *
 * DETERMİNİZM: `weatherFor(track, seed)` saf bir fonksiyon ve tek girdisi
 * SAKLANAN tohum. Saat de, tohumsuz rastgelelik de işin içinde yok; aynı tarif
 * her oynatmada aynı lastiği verir.
 */
export function pitLaneCompound(weather: WeatherPlan): CompoundKey {
  return weather.wetAtStart ? 'WET' : 'HARD';
}

/**
 * Turdan önceki şampiyona tablosu.
 *
 * Lobinin puan tablosu için ayrı bir tablo YOK ve olmaması bilinçli: tablo da
 * yarışın kendisi gibi tarifinden TÜRETİLİR. 1. turda taze tablo; sonraki
 * turlarda aynı sezonun önceki koşuları sırayla yeniden oynatılıp puanları
 * uygulanır. Böylece tablo ile yarışlar asla ayrışamaz — ayrı saklansaydı
 * yeniden oynatılan bir yarış ile saklanan puanlar çelişebilirdi.
 *
 * Koşusu olmayan bir tur (lobi sezon ortasında kuruldu, ya da o tur hiç
 * koşulmadı) sessizce atlanır: olmayan yarış puan da vermez.
 */
export async function standingsBeforeRound(
  lobbyId: string, seasonNo: number, roundNo: number,
): Promise<TeamStanding[]> {
  let standings = freshStandings();
  for (let r = 1; r < roundNo; r += 1) {
    const run = await loadRun(lobbyId, seasonNo, r);
    if (!run) continue;
    const decisions = await loadDecisions(lobbyId, seasonNo, r);
    const state = replayRace({ seed: run.seed, round: r, snapshot: run.snapshot, decisions });
    standings = finishRace(state).standings;
  }
  return standings;
}

/**
 * Işıklar söner: tarifi kurar ve bir kez yazar.
 *
 * İKİ KEZ BAŞLAMAK İMKANSIZ: koruma JavaScript'te değil, `race_runs_pk`te.
 * "Önce satır var mı diye bak, yoksa yaz" biçimi kontrol-sonra-davran yarışıdır;
 * iki süreç de "yok" görür ve ikisi de tarifi kurar. Burada ikinci yazma
 * veritabanından FIRLAR — `startRun`ın sözleşmesi de budur.
 */
export async function startRaceFor(input: StartRaceInput): Promise<StartedRace> {
  const { lobbyId, seasonNo, roundNo, now } = input;

  const seed = deriveSeed(lobbyId, seasonNo, roundNo);
  const track = trackForRound(roundNo);
  const weather = weatherFor(track, seed);

  // Parc fermé tek çağrıda iki çıktı verir ve ikisi de tarife girer: `byTeam`
  // katılımın aracını belirler, `pitLaneStarts` grid cezasını.
  const verdict = await evaluateParcFerme(lobbyId, now);
  const seats = await loadSeats(lobbyId);
  // IŞIKLAR SÖNERKEN TEK SEFER OKUNUR — `managed` ile birebir aynı gerekçeyle
  // (aşağıdaki "DONAN KARAR" yorumu): bundan sonra satır değişse de bu
  // yarışı etkilemez, yalnızca BİR SONRAKİ `startRaceFor` çağrısını.
  const weekendChoices = await loadWeekendChoices(lobbyId);
  const economies = await loadLobbyEconomy(lobbyId);
  const factoryLevelsByTeam = new Map(economies.map((e) => [e.teamKey, e.factoryLevels]));

  const entries: Entries = {};
  const risks: Record<string, QualiRisk> = {};
  for (const seat of seats) {
    // Sahipsiz koltuk katılım LİSTESİNE HİÇ GİRMEZ: motorun sözleşmesinde
    // `entries`te olmayan takım AI'dır. Boş bir katılım yazmak, AI'yı oyuncu
    // sayfasına geçirirdi.
    if (seat.managed === 'ai') continue;

    const pf = verdict.byTeam[seat.teamKey];
    // Ekonomi satırı lobiyle birlikte doğar; yoksa araç da yoktur, o koltuğu
    // oyuncu sayfasına almak yerine AI'ya bırakmak dürüst olanıdır.
    if (!pf) continue;

    // Seçim yoksa (koltuk hiç göndermemiş) bugünkü varsayılana düş —
    // seçimler OPSİYONELDİR, göndermemiş bir koltuk yine de yarışmalıdır.
    const choices = weekendChoices[seat.teamKey];
    const base: CarSetup = {
      motor: pf.car.motor,
      aero: pf.car.aero,
      grip: pf.car.grip,
      compound: choices?.compound ?? DEFAULT_COMPOUND,
      bias: choices?.bias ?? 0,
    };
    const reliability = reliabilityFor(factoryLevelsByTeam.get(seat.teamKey) ?? {});
    entries[seat.teamKey] = {
      // Tezgahta duran geliştirme pişen statı yarıya indirir...
      setup: crippleSetup(base, pf.buildingLabel),
      // ...ve DNF riskini katlar. İkisi birlikte "araç sökük yarışıyor" demek.
      reliability: pf.crippled ? reliability / CRIPPLED_DNF_SCALE : reliability,
      tactics: choices?.tactics ?? DEFAULT_TACTICS,
      // DONAN KARAR: check-in yapan oyuncu kendi yarışını sürer, yapmayanı
      // asistan devralır. Bu, yarış boyunca bir daha SORULMAZ.
      managed: seat.managed,
    };
    risks[seat.teamKey] = choices?.qualiRisk ?? DEFAULT_RISK;
  }

  // Cezalı araçların serbest lastiğini burada dolduruyoruz: `parcFerme.ts`
  // bilerek boş bırakıyor (saat/tohum orada yok), telafiyi verecek yer burası.
  const pitLaneStarts: Record<string, PitLaneStart> = {};
  for (const id of Object.keys(verdict.pitLaneStarts)) {
    pitLaneStarts[id] = { ...verdict.pitLaneStarts[id], compound: pitLaneCompound(weather) };
  }

  const snapshot: RaceSnapshot = {
    entries,
    risks,
    standings: await standingsBeforeRound(lobbyId, seasonNo, roundNo),
    // Rakip istihbaratının (casusluk) kalıcı AI bonusu ve lobiye özel pilot
    // kadroları henüz sunucuda saklanmıyor. Boş bırakmak motorun varsayılanı
    // ile aynı yarışı verir; ama alanlar TARİFTE durduğu için, kaynakları
    // eklendiğinde bugün koşulan yarışlar değişmeden oynatılmaya devam eder.
    aiBonus: {},
    rosters: {},
    pitLaneStarts,
  };

  await withTransaction((client) =>
    startRun(client, { lobbyId, seasonNo, roundNo, seed, snapshot, now }),
  );

  return { seed, snapshot };
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 * TİK DÖNGÜSÜ — yarışı ileri süren taraf.
 *
 * NEDEN DURUM BELLEKTE, YENİDEN OYNATMA SADECE KURTARMADA:
 * Her tikte tarifi baştan oynatmak DOĞRU sonucu verir ama maliyeti turların
 * KARESİDİR: bu depoda ölçüldü, 70. tura oynatma ~0.8 ms ve tur başına ~11 µs.
 * Yani 78 turluk bir yarış, her tikte baştan oynatılırsa lobi başına ~33 ms
 * CPU eder; durumu bellekte tutup tik başına tek `advanceLap` çağırmak ~0.9 ms.
 * 300 eşzamanlı lobide fark, tik turu başına ~0.25 saniyedir — yani tik
 * aralığının onda biri, tek bir işi yeniden yapmak için.
 *
 * Bu yüzden: BELLEKTEKİ `RaceState` KARARLI YOLDUR, yeniden oynatma KURTARMA
 * yoludur (çökme sonrası devam, geç bağlanan istemci). Buradaki döngüyü "her
 * tikte `replayRace` çağır, daha basit" diye sadeleştirmek ölçülmüş bir
 * gerilemedir. İkisinin AYNI yarışı vermesi tesadüf değil, koşuludur:
 * `advanceLap` rastgeleliğini `(seed, round, lap)` üçlüsünden çeker ve her iki
 * yol da aynı `decisionsForLap` yardımcısını kullanır.
 *
 * NEDEN TUR SAYACI DA SAKLANMIYOR:
 * "Kaçıncı turdayız" bir DURUMDUR ve saklansaydı tarifin dışında ikinci bir
 * gerçek kaynağı olurdu. Onun yerine yarış SAATTEN türetilir:
 * `tur = (now - started_at) / RACE_TICK_MS`. Böylece çöken bir süreç, geri
 * geldiğinde nerede olması GEREKTİĞİNİ hesaplar; kaçırdığı turları tek tikte
 * yetişerek kapatır ve oyuncular donmuş bir ekran yerine hızlanmış bir yarış
 * görür. Saat `now` ile çağırandan gelir (server/README.md §"now sadece
 * route'ta örneklenir"), yani test gerçek zamanlıyıcı beklemeden sürebilir.
 *
 * NEDEN `entries`/`standings` ASLA DEĞİŞTİRİLMEZ:
 * `startRace` bunları REFERANSLA saklar (`state.entries === snapshot.entries`).
 * Burada mutasyon yapmak tarifi bozardı ve bozulan tarif, o yarışı bundan
 * sonra oynatan HERKESE başka bir yarış gösterirdi. `advanceLap` saf; bu modül
 * de yalnızca döndürdüğü yeni durumu tutar.
 */

/**
 * Bir yarış turunun gerçek zamandaki uzunluğu.
 *
 * `src/index.ts`in TICK_MS'iyle aynı varsayılan: tik başına bir tur. Sabit
 * BURADA duruyor çünkü yarışın turu artık zamanlayıcının sıklığından değil
 * SAATTEN türüyor — iki sayı ayrışırsa yarış, ekranda hızlanır ya da yavaşlar
 * ama çökme sonrası HEP saatin dediği yere döner. `tickMs` yine de koşucuya
 * geçirilebilir ki test ve ileride lobiye özel hızlar tek yerden ayarlansın.
 */
export const RACE_TICK_MS = 2_500;

export interface OpenRaceInput {
  lobbyId: string;
  seasonNo: number;
  roundNo: number;
  /** Kirayı tutan süreç kimliği; `acquireDueLobbies`e verilenin aynısı. */
  ownerId: string;
  now: Date;
  tickMs?: number;
  /** Testin muhasebeyi yarıda patlatabilmesi için; üretimde hep varsayılan. */
  settleDeps?: SettleDeps;
}

export interface TickResult {
  /** `false`: kira bizde değil — çağıran bu koşucuyu BIRAKMALIDIR. */
  owned: boolean;
  /** Bu tikte koşulan tur sayısı (yetişme sırasında birden çok olabilir). */
  advanced: number;
  finished: boolean;
  state: RaceState;
}

export interface OpenedRace {
  readonly lobbyId: string;
  readonly seasonNo: number;
  readonly roundNo: number;
  readonly ownerId: string;
  /** O anki yarış. Çağıran BUNU DEĞİŞTİRMEZ — tarifin nesneleri paylaşılıyor. */
  readonly state: RaceState;
  tick(now: Date): Promise<TickResult>;
}

/** Yarış saatinin dediği tur. Negatife düşmez: ışıklar sönmeden tur koşulmaz. */
function lapForClock(now: Date, startedAt: Date, tickMs: number): number {
  return Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / tickMs));
}

class RaceRunner implements OpenedRace {
  private current: RaceState;
  /** Bayrak işlendi mi — `finished_at` ve evre iki kez yazılmasın. */
  private flagged = false;

  constructor(
    readonly lobbyId: string,
    readonly seasonNo: number,
    readonly roundNo: number,
    readonly ownerId: string,
    private readonly startedAt: Date,
    private readonly tickMs: number,
    state: RaceState,
    // Testin "damgadan SONRA patlarsa her şey geri alınır" iddiasını
    // kanıtlayabilmesi için enjekte edilebilir (bkz. `settleRace`in kendi
    // `deps` deseni). Üretimde her zaman varsayılan `addRp`.
    private readonly settleDeps?: SettleDeps,
  ) {
    this.current = state;
  }

  get state(): RaceState {
    return this.current;
  }

  async tick(now: Date): Promise<TickResult> {
    // KİRA ÖNCE: sahipliği kaybetmiş bir süreç tek bir tur bile koşmamalıdır.
    // Aynı yarışı iki süreç sürerse iki ayrı yayın doğar ve "herkes aynı
    // yarışı görür" şartı tam da orada kırılır. `renewLease` kararı UPDATE'in
    // kendi `where`inde verir; burada bir `select` ile önceden sormak
    // kontrol-sonra-davran yarışı olurdu.
    if (this.flagged || !(await renewLease(this.ownerId, this.lobbyId, now))) {
      return { owned: false, advanced: 0, finished: this.current.finished, state: this.current };
    }

    const track = trackForRound(this.roundNo);
    const target = Math.min(lapForClock(now, this.startedAt, this.tickMs), this.current.laps);
    let advanced = 0;

    if (!this.current.finished && target > this.current.lap) {
      // ── SIRALAMA: ÖNCE DAMGA, SONRA GÜNLÜK, EN SON SİMÜLASYON ────────────
      // Üçünün sırası bu fazın tek yapısal garantisidir; değiştirmeyin.
      //
      // 1. `last_lap = target` damgalanır ve TAAHHÜT EDİLİR. O an itibarıyla
      //    `appendDecision`ın kapısı `lap <= target` için KAPANIR: uç nokta
      //    aynı satırı `for update` ile kilitlediği için, bu UPDATE sürerken
      //    gelen bir karar bekler ve kilit çözülünce yeni `last_lap`i görüp
      //    reddedilir. "Tur koşarken araya giren karar" diye bir şey kalmaz.
      // 2. Günlük damgadan SONRA okunur. Kabul edilmiş her karar, damgadan
      //    ÖNCE taahhüt edilmiş olmak zorundadır (1'den ötürü), dolayısıyla bu
      //    okuma onların HEPSİNİ görür. Ters sıra — önce oku, sonra damgala —
      //    tam da kapatmaya çalıştığımız pencereyi bırakırdı.
      // 3. Simülasyon en son. Damganın simülasyondan önce olması "koşacağız"
      //    demektir, "koştuk" değil: süreç arada çökerse `last_lap` koşulmamış
      //    bir turu gösterir. Bu YANLIŞ YÖNDE yanılmaktır ve zararsızdır —
      //    kurtarma yolu (`openRace`) o tura kadar zaten yeniden oynatır ve o
      //    turlara karar yazılamadığı için oynatma canlı yarışla aynı kalır.
      //    Tersi (önce simüle et, sonra damgala) koşulmuş bir tura karar
      //    yazılmasına izin verirdi: iki farklı yarış.
      await withTransaction((client) =>
        advanceLastLap(client, { lobbyId: this.lobbyId, seasonNo: this.seasonNo, roundNo: this.roundNo }, target),
      );

      // Günlük HER TİKTE yeniden okunur: az önce yazılmış bir pit çağrısı, etki
      // ettiği tur koşulmadan önce görünmek zorunda. Koşulmuş bir tura ait geç
      // bir satır ise doğal olarak etkisizdir — o tur bir daha koşulmaz, yani
      // karar geriye dönük uygulanamaz. (Böyle bir satır uç noktadan artık
      // GEÇEMEZ; yalnızca doğrudan SQL ile yazılabilir.)
      const decisions: DecisionLogEntry[] = await loadDecisions(this.lobbyId, this.seasonNo, this.roundNo);
      while (!this.current.finished && this.current.lap < target) {
        const lap = this.current.lap + 1;
        // Yeniden oynatmayla AYNI yardımcı: iki kopya olsa ayrışabilirlerdi.
        this.current = advanceLap(this.current, track, decisionsForLap(decisions, lap));
        advanced += 1;
      }
    }

    if (this.current.finished) await this.flag(now);
    return { owned: true, advanced, finished: this.current.finished, state: this.current };
  }

  /**
   * Damalı bayrak: koşu damgalanır, lobi `result` evresine geçer, MUHASEBE
   * yapılır ve kira bırakılır.
   *
   * Damga + evre + muhasebe TEK işlemde. Eskiden `settleRace` ayrı bir
   * işlemde çağrılıyordu (süpürme döngüsünün işiydi) ve tam da bu ayrım bir
   * çöküş deliği açıyordu: `finishRun` + evre geçişi taahhüt edilip süreç
   * `settleRace`den ÖNCE çökerse, lobi `result` evresinde ama HİÇ ödenmemiş
   * kalırdı — ve `result` evresi artık `acquireDueLobbies`in taradığı
   * evrelerden biri olmadığı için (`lease.ts` `DUE_PHASES`), bu yarış BİR
   * DAHA ASLA kimse tarafından ele alınmaz, ödemesi sonsuza dek kaybolurdu.
   * Üçünü tek taahhüde almak bu üçlü yazmayı ATOMIK yapar: ya hepsi birden
   * kalıcı olur ya hiçbiri — arada çöken bir süreç, bıraktığı yarışı hâlâ
   * `live` ve hâlâ ödenmemiş bulur, sonraki devralan onu SIFIRDAN bitirir.
   *
   * Evre güncellemesinin `phase = 'live'` koşulu kasıtlı: lobiyi bu arada
   * başkası ilerletmişse (ya da sezon ilerlemesi devralmışsa) onun yazdığını
   * ezmeyiz.
   *
   * `AlreadySettledError` BURADA YUTULMAZ — yukarı, çağıran süpürme döngüsüne
   * fırlar. Neden yutulmaması gerektiği o döngünün kendi dokümantasyonunda:
   * bu istisna normal bir çökme-sonrası durumdur, `flag()`in kendisinin
   * anlayabileceği ya da anlamlandırması gereken bir şey değildir.
   */
  private async flag(now: Date): Promise<void> {
    if (this.flagged) return;
    this.flagged = true;
    await withTransaction(async (client) => {
      await finishRun(client, this.lobbyId, this.seasonNo, this.roundNo, now);
      await client.query(
        `update lobbies set phase = 'result' where id = $1 and phase = 'live'`,
        [this.lobbyId],
      );
      // AYNI CLIENT, AYNI İŞLEM: `settleRace`e üçüncü argüman olarak
      // geçirilen `client`, onun kendi `withTransaction`ını hiç açmamasını
      // sağlar (bkz. `economy/settle.ts` docblock'u). Yukarıdaki iki yazmayla
      // birlikte tek taahhütte gider.
      await settleRace({ lobbyId: this.lobbyId, seasonNo: this.seasonNo, roundNo: this.roundNo, now }, this.settleDeps, client);
    });
    // Kirayı gönüllü bırakmak, sıradaki taramanın 15 sn beklemesini önler.
    // Yalnızca yukarıdaki işlem BAŞARIYLA taahhüt edildiyse buraya varılır —
    // fırlayan bir `settleRace` bu satırı hiç çalıştırmaz, kira kendi
    // süresince kalır ve bir sonraki devralan yarışı sıfırdan bitirir.
    await releaseLease(this.ownerId, this.lobbyId);
  }
}

interface PhaseRow {
  phase: string;
}

/**
 * Bir lobinin yarışını açar: tarifi bulur (yoksa ışıkları söndürür) ve yarış
 * saatinin dediği tura kadar oynatarak belleğe alır.
 *
 * NEDEN EVRE VERİTABANINDAN OKUNUYOR:
 * "Bu lobi yarışıyor" kararı, kendi `advanceDuePhases` çağrımızın dönüşüne
 * DAYANDIRILAMAZ. O fonksiyon kirasız ve etkisiz-tekrarlanabilir; lobiyi
 * `live`e taşıyan pekâlâ BAŞKA bir süreç olabilir ve o zaman bizim dönüşümüz
 * boş gelir. Dönüşe bakan bir koşucu, komşusunun ilerlettiği yarışları sessizce
 * atlardı. Otorite satırdır: `phase = 'live'` ise yarış vardır.
 *
 * `null`: bu lobide sürülecek yarış yok (evre `live` değil).
 */
export async function openRace(input: OpenRaceInput): Promise<OpenedRace | null> {
  const { lobbyId, seasonNo, roundNo, ownerId, now } = input;
  const tickMs = input.tickMs ?? RACE_TICK_MS;

  const phase = await query<PhaseRow>('select phase from lobbies where id = $1', [lobbyId]);
  if (phase.rows[0]?.phase !== 'live') return null;

  // Tarif yoksa ışıklar bu an söner ve yarış saati de bu andan başlar.
  // İki süreç aynı anda denerse ikincisi `race_runs_pk`ten FIRLAR; bu beklenen
  // bir yarış değil, kiralamada bir hatadır ve görünmesi gerekir.
  let run = await loadRun(lobbyId, seasonNo, roundNo);
  if (!run) {
    const started = await startRaceFor({ lobbyId, seasonNo, roundNo, now });
    run = { seed: started.seed, snapshot: started.snapshot, startedAt: now, finishedAt: null, lastLap: 0 };
  }

  const decisions = await loadDecisions(lobbyId, seasonNo, roundNo);
  // KURTARMA YOLU: buraya kadar olan her şey tarife göre yeniden üretilir.
  // Bundan sonrası bellekten yürür (yukarıdaki docblock'a bakın).
  const state = replayRace({
    seed: run.seed,
    round: roundNo,
    snapshot: run.snapshot,
    decisions,
    // SAAT DEĞİL, İKİSİNİN BÜYÜĞÜ. `last_lap` "şu tur simüle edildi" diyorsa
    // canlı durum oranın GERİSİNDE açılamaz: o turlara karar yazma kapısı
    // kapandı, yani onları burada yeniden koşmamak (ve sonra tekrar koşmak)
    // oyunculara kararsız bir yarış gösterirdi. Saat ileriyse yetişme yine
    // saatin dediği yere kadar sürer.
    uptoLap: Math.max(lapForClock(now, run.startedAt, tickMs), run.lastLap),
  });

  return new RaceRunner(lobbyId, seasonNo, roundNo, ownerId, run.startedAt, tickMs, state, input.settleDeps);
}
