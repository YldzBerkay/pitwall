/**
 * Ekonomi denge kontrolü.
 *
 * Projede test çerçevesi yok; bu script tasarım spec'inin (§11) ölçülebilir
 * iddialarını koşar. Denge bir görüş meselesi değil, bir eşik meselesi olsun
 * diye her iddia bir aralıkla yazılır.
 *
 *   npm run econ
 */
import { ECONOMY_SCALE, GOLD_PER_HOUR, GOLD_TO_RP, GOLD_TO_RP_DAILY_CAP, goldPacks, goldPrices, rpPrices, skipCostGold } from '@pitwall/shared/economy';
import { racePrize } from '@pitwall/shared/sponsors';
import { championshipPrize, regressCar, rivalFactoryLevel } from '@pitwall/shared/season';
import { CRIPPLED_DNF_SCALE, crippleSetup } from '@pitwall/shared/raceEngine';
import { SPY_COOLDOWN_MS, SPY_RESOLVE_MS } from '@pitwall/shared/espionage';
import { DEPARTMENT_MAX_LEVEL, departmentCost, factoryEffects } from '@pitwall/shared/factory';
import { aiStrength } from '@pitwall/shared/raceEngine';
import { teams } from '@pitwall/shared/teams';
import { wageFor } from '@pitwall/shared/staff';
import { SQUAD_MAX, SQUAD_MIN, TRAINING_MS, driverFee, driverWage, saleValue, trainingGain } from '@pitwall/shared/driverMarket';
import { UPGRADE_GAIN, UPGRADE_MAX_MS, upgradeCostFor, upgradeDurationMs } from '@pitwall/shared/carCustomisation';

/** Yarışlar arası gerçek süre, ~2,5 gün. */
const RACE_GAP_MS = 60 * 3600_000;

let failed = 0;
export const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
export const near = (v: number, lo: number, hi: number): boolean => v >= lo && v <= hi;

console.log('── Ölçek ──');
check('ECONOMY_SCALE 1.5', ECONOMY_SCALE === 1.5, String(ECONOMY_SCALE));
check('yarış ödülü P1 ~600', near(racePrize(1, 11), 570, 630), String(racePrize(1, 11)));
check('yarış ödülü P11 ~260', near(racePrize(11, 11), 240, 280), String(racePrize(11, 11)));
check('sezon ödülü P1 9000', championshipPrize(1, 11) === 9000, String(championshipPrize(1, 11)));
check('sezon ödülü P11 2500', championshipPrize(11, 11) === 2500, String(championshipPrize(11, 11)));

// Bir sürücü iskeleti: stat'ların hepsi aynı olunca ortalama = o değer.
const drv = (overall: number, potential = overall, age = 26) => ({
  name: 'T. Test', number: 99, age, potential,
  stats: { pace: overall, consistency: overall, racecraft: overall, wet: overall, reaction: overall, dev: overall },
  skill: overall,
}) as Parameters<typeof driverFee>[0];

console.log('\n── Maaşlar ──');
check('personel maaşı y40 = 41', wageFor(40) === 41, String(wageFor(40)));
check('personel maaşı y90 = 119', wageFor(90) === 119, String(wageFor(90)));
check('sürücü maaşı ort55 = 60', driverWage(drv(55)) === 60, String(driverWage(drv(55))));
check('sürücü maaşı ort95 = 250', driverWage(drv(95)) === 250, String(driverWage(drv(95))));

console.log('\n── Sürücü fiyatı ve ticaret ──');
check('bedel ort58/pot70 ~1294', near(driverFee(drv(58, 70)), 1250, 1340), String(driverFee(drv(58, 70))));
check('bedel ort95/pot97 ~14485', near(driverFee(drv(95, 97)), 14000, 15000), String(driverFee(drv(95, 97))));
check('yıldız >= 12 yarışlık gelir', driverFee(drv(95, 97)) >= 12 * 1100, String(driverFee(drv(95, 97))));
check('satış %20 komisyonlu', saleValue(drv(76, 88)) === Math.round(driverFee(drv(76, 88)) * 0.8));
const kar = saleValue(drv(76, 88)) - driverFee(drv(62, 88));
check('ticaret kârlı (62→76)', near(kar, 900, 1500), `${kar} RP`);

console.log('\n── Araç merdiveni ──');
check('1. yükseltme 750 RP', upgradeCostFor(0) === 750, String(upgradeCostFor(0)));
check('2. yükseltme 1125 RP', upgradeCostFor(1) === 1125, String(upgradeCostFor(1)));
check('5. yükseltme 3797 RP', upgradeCostFor(4) === 3797, String(upgradeCostFor(4)));
check('fiyat tavanlanmaz', upgradeCostFor(9) > upgradeCostFor(8));
check('süre 22 sa tavanlı', upgradeDurationMs(9) === UPGRADE_MAX_MS, `${upgradeDurationMs(9) / 3600_000} sa`);
// OSM tarzı günlük döngü: yatmadan başlatılan iş ertesi akşam yarıştan önce
// hazır olmalı. Tavan, YARIŞA ÇIKMAYI ENGELLEYEN işler için — tezgahtaki
// parça aracı sökük bırakır, antrenmandaki sürücü koltuğa oturamaz.
// Casus bu listede yok: yarışa dokunmaz, sadece geliştirmeye çarpan verir.
const RACE_BLOCKING_MS = [UPGRADE_MAX_MS, TRAINING_MS];
check('yarışı engelleyen hiçbir iş 22 saati aşmaz',
  RACE_BLOCKING_MS.every((ms) => ms <= 22 * 3600_000),
  RACE_BLOCKING_MS.map((ms) => `${ms / 3600_000}sa`).join(' '));
check('en uzun iş bir yarış arasına sığar', UPGRADE_MAX_MS < RACE_GAP_MS,
  `${UPGRADE_MAX_MS / 3600_000} sa < ${RACE_GAP_MS / 3600_000} sa`);
check('taban kazanç 6', UPGRADE_GAIN === 6, String(UPGRADE_GAIN));

console.log('\n── Kış reseti ──');
check('§11.6 91 stat + fabrika 6 → 74', regressCar(91, 6) === 74, String(regressCar(91, 6)));
check('§11.6 reset 70-76 bandında',
  [88, 90, 91].every((v) => near(regressCar(v, 6), 70, 76)),
  [88, 90, 91].map((v) => regressCar(v, 6)).join('/'));
check('fabrikasız reset tabana yakın', near(regressCar(90, 0), 66, 68), String(regressCar(90, 0)));
check('reset merdiveni yeniden açar', regressCar(91, 6) < 91 - 6);
check('rakip fabrika seviyesi 2-5', [41, 70, 93].every((b) => near(rivalFactoryLevel(b), 2, 5)),
  [41, 70, 93].map(rivalFactoryLevel).join('/'));

// Rakiplere gerileme UYGULANMAZ: aiStrength gücü `round` üzerinden okuyor,
// yani rakipler zaten her sezon sıfırlanıyor ve sezonlar arası büyümüyorlar.
// Onlara gerileme uygulamak her yıl zayıflatırdı. Asıl denge şu: oyuncunun
// reset sonrası tabanı en güçlü rakibin ALTINDA, sezon sonu tavanı ÜSTÜNDE —
// yani her sezon yeniden tırmanılacak gerçek bir rakip var.
const topRival = Math.max(...teams.filter((t) => !t.isPlayer).map((t) => aiStrength(t, 1)));
check('reset sonrası oyuncu en güçlü rakibin altında', regressCar(91, 6) < topRival,
  `oyuncu ${regressCar(91, 6)} < rakip ${topRival.toFixed(1)}`);
check('sezon sonu oyuncu en güçlü rakibin üstünde', 90 > aiStrength(teams.find((t) => !t.isPlayer && t.baseStrength === Math.max(...teams.filter((x) => !x.isPlayer).map((x) => x.baseStrength)))!, 23),
  `90 > ${aiStrength(teams.filter((t) => !t.isPlayer).sort((a, b) => b.baseStrength - a.baseStrength)[0], 23).toFixed(1)}`);

console.log('\n── Fabrika ──');
check('L1→2 1500 RP', departmentCost(1) === 1500, String(departmentCost(1)));
check('L4→5 7369 RP', departmentCost(4) === 7369, String(departmentCost(4)));
check('departman tavanı 5', DEPARTMENT_MAX_LEVEL === 5, String(DEPARTMENT_MAX_LEVEL));
const fx = factoryEffects({ wind_tunnel: 3, data_center: 2, manufacturing: 2, engine_lab: 1, driver_academy: 3 });
check('rüzgar tüneli +0,4/seviye', Math.abs(fx.upgradeGainBonus - 1.2) < 1e-9, String(fx.upgradeGainBonus));
check('üretim maliyeti -%6/seviye', Math.abs(fx.upgradeCostScale - 0.88) < 1e-9, String(fx.upgradeCostScale));
check('akademi +%8/seviye', Math.abs(fx.trainingScale - 1.24) < 1e-9, String(fx.trainingScale));
check('kış tabanı +1,5/seviye', fx.winterFloorBonus === 16.5, String(fx.winterFloorBonus));
check('tam fabrika indirimi tabanlı', factoryEffects({ manufacturing: 9 }).upgradeCostScale === 0.7);
// Tam fabrika bir sezonun tamamından pahalı olmalı: 4 sezonluk hedef.
const fullFactory = 5 * [1, 2, 3, 4].reduce((a, l) => a + departmentCost(l), 0);
check('tam fabrika >= 1 sezon geliri', fullFactory >= 23 * 1100, `${fullFactory} RP`);

console.log('\n── İstihbarat ──');
check('rapor 24 sa', SPY_RESOLVE_MS === 24 * 3600_000, `${SPY_RESOLVE_MS / 3600_000} sa`);
check('bekleme 48 sa', SPY_COOLDOWN_MS === 48 * 3600_000, `${SPY_COOLDOWN_MS / 3600_000} sa`);
check('rapor atlama 120 Altın', skipCostGold(SPY_RESOLVE_MS) === 120, String(skipCostGold(SPY_RESOLVE_MS)));
// Casus 22 saatlik tavanın dışında: yarışa dokunmuyor, sadece geliştirmeye
// çarpan veriyor. Tavan, yarışa çıkmayı engelleyen işler için.
check('casus yarışı etkileyen gruplarda değil', SPY_RESOLVE_MS > 22 * 3600_000,
  `${SPY_RESOLVE_MS / 3600_000} sa — kasıtlı`);

console.log('\n── Kadro ──');
check('kadro tabanı 2', SQUAD_MIN === 2, String(SQUAD_MIN));
check('kadro tavanı 6', SQUAD_MAX === 6, String(SQUAD_MAX));
// Spec §7: elit 6'lı kadro P1 gelirinden geriye en ucuz geliştirmeyi
// karşılayamayacak kadar az bırakmalı — tercih gerçekten acıtsın.
// Asıl iki koltuk tam maaş; kadrodakiler imzada yarıya indirilmiş sözleşme
// ücretiyle gelir (signDriver), o yüzden burada da yarı sayılır.
const half = (ov: number) => Math.round(driverWage(drv(ov)) / 2);
const eliteWages = driverWage(drv(95)) + driverWage(drv(92))
  + half(85) + half(85) + half(82) + half(82)
  + wageFor(90) * 3;
check('elit kadro P1 gelirinden geriye < 750 RP bırakır',
  1450 - eliteWages < upgradeCostFor(0) && 1450 - eliteWages > 0,
  `${1450 - eliteWages} RP kalır (maaş ${eliteWages})`);
const leanWages = driverWage(drv(70)) + driverWage(drv(68)) + wageFor(52);
check('yalın kadro merdiveni fonlar', 1450 - leanWages > upgradeCostFor(0), `${1450 - leanWages} RP kalır (maaş ${leanWages})`);

console.log('\n── Altın ──');
check('kur 1 Altın = 50 RP', GOLD_TO_RP === 50, String(GOLD_TO_RP));
check('hızlandırma 5 Altın/saat', GOLD_PER_HOUR === 5, String(GOLD_PER_HOUR));
check('6 sa atlama 30 Altın', skipCostGold(6 * 3600_000) === 30, String(skipCostGold(6 * 3600_000)));
check('kısmi saat yukarı yuvarlanır', skipCostGold(30 * 60_000) === 5, String(skipCostGold(30 * 60_000)));
check('biten iş 0 Altın', skipCostGold(0) === 0, String(skipCostGold(0)));
check('paketler 60/180/500', goldPacks.map((p) => p.gold).join('/') === '60/180/500', goldPacks.map((p) => p.gold).join('/'));
check('büyük paket daha ucuz/Altın',
  goldPacks[2].gold / 299.99 > goldPacks[0].gold / 49.99);
check('sadece-Altın mekaniği yok',
  Object.keys(goldPrices).every((k) => k in rpPrices), Object.keys(goldPrices).join(','));
check('sabır Altın\'dan ucuz (6 sa atlama > geliştirme fiyatı)',
  skipCostGold(6 * 3600_000) * GOLD_TO_RP > upgradeCostFor(0),
  `${skipCostGold(6 * 3600_000) * GOLD_TO_RP} RP > ${upgradeCostFor(0)} RP`);
check('§11.7 bedava RP < döngü gelirinin %30\'u',
  GOLD_TO_RP_DAILY_CAP * GOLD_TO_RP * 2.5 < 1100 * 2.5 * 0.3,
  `${GOLD_TO_RP_DAILY_CAP * GOLD_TO_RP * 2.5} RP/döngü`);

console.log('\n── Yarış günü kilidi ──');
const baseSetup = { motor: 80, aero: 88, grip: 76, compound: 'MEDIUM' as const, bias: 0 };
const hurt = crippleSetup(baseSetup, 'AERO');
check('pişen stat yarı değerde', hurt.aero === 44, String(hurt.aero));
check('diğer statlar bozulmaz', hurt.motor === 80 && hurt.grip === 76);
check('kilit yoksa setup aynı nesne', crippleSetup(baseSetup, undefined) === baseSetup);
check('bilinmeyen etiket ceza vermez', crippleSetup(baseSetup, 'ZZZ') === baseSetup);
check('DNF katsayısı 2', CRIPPLED_DNF_SCALE === 2, String(CRIPPLED_DNF_SCALE));

// ── Sezon simülasyonu ──────────────────────────────────────────────────────
// Gerçek fiyat ve süre fonksiyonlarını kullanır, yarış motorunu değil (o ayrı
// bir iş). Amaç ekonominin TEMPOSUNU ölçmek: para ve takvim bir sezonda
// oyuncuyu nereye götürüyor.
interface SimOut { stats: number[]; bought: number[]; builds: number; pos: number; rp: number }

const PADDOCK_RESERVE = 1200;       // transfer ve personel için ayrılan
const START_RP = 3000;

function simulateSeason(wagePerRace: number): SimOut {
  let rp = START_RP, pos = 6, builds = 0;
  const stats = [67, 58, 72], bought = [0, 0, 0];
  for (let r = 1; r <= 23; r++) {
    rp += Math.round(1450 - 70 * (pos - 1)) - wagePerRace;
    let ms = RACE_GAP_MS;
    // Tek tezgah: yarış arasına sığdığı ve rezerv bozulmadığı sürece en
    // düşük stat'a yatır.
    for (;;) {
      const i = stats.indexOf(Math.min(...stats));
      const cost = upgradeCostFor(bought[i]);
      const dur = upgradeDurationMs(bought[i]);
      if (rp - cost < PADDOCK_RESERVE || dur > ms) break;
      rp -= cost; ms -= dur; builds++;
      stats[i] = Math.min(100, stats[i] + UPGRADE_GAIN); bought[i]++;
    }
    const avg = stats.reduce((a, b) => a + b, 0) / 3;
    pos = Math.max(1, Math.min(11, Math.round(11 - (avg - 55) / 4.2)));
  }
  return { stats, bought, builds, pos, rp };
}

console.log('\n── Sezon simülasyonu ──');
const lean = simulateSeason(leanWages);
const leanAvg = lean.stats.reduce((a, b) => a + b, 0) / 3;
console.log(`     yalın kadro: araç ${lean.stats.join('/')} (ort ${leanAvg.toFixed(1)}) · P${lean.pos} · ${lean.builds} geliştirme ${lean.bought.join('/')} · ${lean.rp} RP kaldı`);
check('§11.1 sezon sonu araç 88-92', near(leanAvg, 88, 92), leanAvg.toFixed(1));
check('§11.1 sezon sonu P1-P4', lean.pos <= 4, `P${lean.pos}`);
check('§11.2 stat başına <= 6 yükseltme', Math.max(...lean.bought) <= 6, lean.bought.join('/'));
check('§11.3 sezon boyu 10-14 geliştirme', near(lean.builds, 10, 14), String(lean.builds));

const elite = simulateSeason(eliteWages);
const eliteAvg = elite.stats.reduce((a, b) => a + b, 0) / 3;
console.log(`     elit kadro:  araç ${elite.stats.join('/')} (ort ${eliteAvg.toFixed(1)}) · P${elite.pos} · ${elite.builds} geliştirme`);
check('§11.4 elit kadro >= 8 puan geride', leanAvg - eliteAvg >= 8, `${(leanAvg - eliteAvg).toFixed(1)} puan`);

// §11.5: ticaret kârlı olmalı ama baskın olmamalı.
//
// Kaç sürücü çevrilebileceğini uydurmak yerine ölçüyoruz: antrenman koltuğu
// TEK ve seans 6 saat, yani sezonun kârını belirleyen şey para değil ZAMAN.
// Bir genci 62'den 76'ya çıkarmak kaç seans sürüyorsa, sezona o kadar
// çevirme sığar.
function sessionsToRaise(from: number, to: number, potential: number, age: number): number {
  const stats = { pace: from, consistency: from, racecraft: from, wet: from, reaction: from, dev: from };
  const keys = Object.keys(stats) as (keyof typeof stats)[];
  let sessions = 0;
  while (keys.reduce((a, k) => a + stats[k], 0) / 6 < to && sessions < 5000) {
    // En düşük stat'a çalış — oyuncunun yapacağı da bu.
    const k = keys.reduce((lo, cur) => (stats[cur] < stats[lo] ? cur : lo), keys[0]);
    stats[k] += trainingGain({ stats, age, potential } as Parameters<typeof trainingGain>[0], k);
    sessions++;
  }
  return sessions;
}

const SEASON_MS = 23 * RACE_GAP_MS;
const sessionsPerFlip = sessionsToRaise(62, 76, 88, 21);
const flipsPerSeason = Math.floor(SEASON_MS / (sessionsPerFlip * TRAINING_MS));
const perFlip = saleValue(drv(76, 88)) - driverFee(drv(62, 88));
const tradeProfit = flipsPerSeason * perFlip;
const seasonIncome = 23 * 1100;
console.log(`     çevirme başına ${sessionsPerFlip} seans (${Math.round(sessionsPerFlip * TRAINING_MS / 86_400_000)} gün) · sezona ${flipsPerSeason} çevirme sığar`);
check('§11.5 ticaret kârlı', tradeProfit > 0, `${tradeProfit} RP`);
check('§11.5 ticaret kârı < sezon gelirinin %15\'i', tradeProfit < seasonIncome * 0.15,
  `${tradeProfit} / ${Math.round(seasonIncome * 0.15)} RP`);

console.log(failed === 0 ? '\nTÜMÜ GEÇTİ' : `\n${failed} KONTROL BAŞARISIZ`);
process.exit(failed === 0 ? 0 : 1);
