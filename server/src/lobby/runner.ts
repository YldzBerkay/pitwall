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
  crippleSetup,
  finishRace,
  weatherFor,
  CRIPPLED_DNF_SCALE,
  type CarSetup,
  type Entries,
  type PitLaneStart,
  type QualiRisk,
  type TacticPreset,
  type WeatherPlan,
} from '@pitwall/shared/raceEngine';
import type { CompoundKey } from '@pitwall/shared/carCustomisation';
import { trackForRound } from '@pitwall/shared/tracks';
import { freshStandings } from '@pitwall/shared/season';
import type { TeamStanding } from '@pitwall/shared/teams';
import { withTransaction } from '../db/pool.ts';
import { loadSeats } from './lobbyRepo.ts';
import { evaluateParcFerme } from './parcFerme.ts';
import { loadDecisions, loadRun, startRun } from './raceRepo.ts';
import { replayRace, type RaceSnapshot } from './replay.ts';

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
 * Hafta sonu seçimleri (setup bileşimi, taktik, güvenilirlik, sıralama
 * yaklaşımı) HENÜZ sunucuda saklanmıyor: `lobby_seats`te böyle sütun yok.
 * `server/src/league.ts`in tek ligli sürümünde kullanılan varsayılanlar burada
 * TEK YERDE duruyor ki, o seçimler şemaya geldiğinde değiştirilecek nokta
 * belirsiz kalmasın. Varsayılanlar tarife YAZILDIĞI için bugünkü yarışlar da
 * yarınki kodla aynı şekilde oynatılır.
 */
const DEFAULT_COMPOUND: CompoundKey = 'MEDIUM';
const DEFAULT_TACTICS: TacticPreset = 'balanced';
const DEFAULT_RELIABILITY = 0.3;
const DEFAULT_RISK: QualiRisk = 'safe';

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
async function standingsBeforeRound(
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

    const base: CarSetup = {
      motor: pf.car.motor,
      aero: pf.car.aero,
      grip: pf.car.grip,
      compound: DEFAULT_COMPOUND,
      bias: 0,
    };
    entries[seat.teamKey] = {
      // Tezgahta duran geliştirme pişen statı yarıya indirir...
      setup: crippleSetup(base, pf.buildingLabel),
      // ...ve DNF riskini katlar. İkisi birlikte "araç sökük yarışıyor" demek.
      reliability: pf.crippled ? DEFAULT_RELIABILITY / CRIPPLED_DNF_SCALE : DEFAULT_RELIABILITY,
      tactics: DEFAULT_TACTICS,
      // DONAN KARAR: check-in yapan oyuncu kendi yarışını sürer, yapmayanı
      // asistan devralır. Bu, yarış boyunca bir daha SORULMAZ.
      managed: seat.managed,
    };
    risks[seat.teamKey] = DEFAULT_RISK;
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
