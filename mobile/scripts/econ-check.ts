/**
 * Ekonomi denge kontrolü.
 *
 * Projede test çerçevesi yok; bu script tasarım spec'inin (§11) ölçülebilir
 * iddialarını koşar. Denge bir görüş meselesi değil, bir eşik meselesi olsun
 * diye her iddia bir aralıkla yazılır.
 *
 *   npm run econ
 */
import { ECONOMY_SCALE, GOLD_PER_HOUR, GOLD_TO_RP, GOLD_TO_RP_DAILY_CAP, goldPacks, goldPrices, rpPrices, skipCostGold } from '../src/data/economy';
import { racePrize } from '../src/data/sponsors';
import { championshipPrize } from '../src/data/season';
import { CRIPPLED_DNF_SCALE, crippleSetup } from '../src/data/raceEngine';
import { SPY_COOLDOWN_MS, SPY_RESOLVE_MS } from '../src/data/espionage';
import { DEPARTMENT_MAX_LEVEL, departmentCost, factoryEffects } from '../src/data/factory';
import { wageFor } from '../src/data/staff';
import { SQUAD_MAX, SQUAD_MIN, driverFee, driverWage, saleValue } from '../src/data/driverMarket';
import { UPGRADE_GAIN, upgradeCostFor, upgradeDurationMs } from '../src/data/carCustomisation';

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
check('süre 72 sa tavanlı', upgradeDurationMs(9) === upgradeDurationMs(8));
check('taban kazanç 6', UPGRADE_GAIN === 6, String(UPGRADE_GAIN));

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

console.log(failed === 0 ? '\nTÜMÜ GEÇTİ' : `\n${failed} KONTROL BAŞARISIZ`);
process.exit(failed === 0 ? 0 : 1);
