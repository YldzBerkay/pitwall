/**
 * Fabrika: oyunun çok sezonluk ilerlemesi.
 *
 * Araç statları her kış geriler (bkz. `season.regressCar`); fabrika seviyeleri
 * taşınır. Yani sezon içi ilerleme araçta, kalıcı ilerleme buradadır — ilerleme
 * temposu bir sezon olduğu için sezon ikinin yapacak bir işi kalsın diye.
 *
 * Seviye maliyeti 1,7 katına çıkar: bir sezonun fazlası 1-2 seviye alır, süper
 * takım ~4 sezonda kurulur. Departmanların etkileri `factoryEffects` üzerinden
 * okunur; hiçbir yer seviyeye doğrudan bakmaz, böylece ölçek burada tek başına
 * ayarlanabilir.
 */

import { ECONOMY_SCALE } from './economy';

export const DEPARTMENT_MAX_LEVEL = 5;

const BASE = Math.round(1000 * ECONOMY_SCALE);
const STEP = 1.7;

/** `level` = MEVCUT seviye; dönen değer bir üst seviyenin fiyatı. */
export const departmentCost = (level: number): number =>
  Math.round(BASE * STEP ** Math.max(0, level - 1));

export interface FactoryDepartment {
  code: string;
  icon: string;
  name: string;
  level: number;
  current: string;
  next: string;
}

export const factoryDepartments: FactoryDepartment[] = [
  { code: 'wind_tunnel', icon: 'Wind', name: 'WIND TUNNEL', level: 3, current: 'Yükseltme kazancı +1,2 stat', next: 'Yükseltme kazancı +1,6 stat' },
  { code: 'data_center', icon: 'Database', name: 'DATA CENTER', level: 2, current: 'Tahmin bandı -%20', next: 'Tahmin bandı -%30' },
  { code: 'manufacturing', icon: 'Factory', name: 'MANUFACTURING', level: 2, current: 'Maliyet -%12 · süre -%16', next: 'Maliyet -%18 · süre -%24' },
  { code: 'engine_lab', icon: 'Gauge', name: 'ENGINE LAB', level: 1, current: 'Güvenilirlik +0,02', next: 'Güvenilirlik +0,04' },
  { code: 'driver_academy', icon: 'GraduationCap', name: 'DRIVER ACADEMY', level: 3, current: 'Antrenman +%24', next: 'Antrenman +%32' },
];

export type DepartmentLevels = Record<string, number | undefined>;

export interface FactoryEffects {
  /** Her geliştirmeye eklenen stat (rüzgar tüneli). */
  upgradeGainBonus: number;
  /** Yükseltme maliyeti çarpanı, en düşük 0,70. */
  upgradeCostScale: number;
  /** Yükseltme süresi çarpanı, en düşük 0,60. */
  upgradeTimeScale: number;
  /** Antrenman kazancı çarpanı (sürücü akademisi). */
  trainingScale: number;
  /** Yağmur tahmini bandı çarpanı, en düşük 0,50. */
  forecastScale: number;
  /** Kış resetinde araç tabanına eklenen puan — taşınan tek şey. */
  winterFloorBonus: number;
}

const lvl = (levels: DepartmentLevels, code: string): number => Math.max(0, levels[code] ?? 0);

export function factoryEffects(levels: DepartmentLevels): FactoryEffects {
  const total = factoryDepartments.reduce((sum, d) => sum + lvl(levels, d.code), 0);
  return {
    upgradeGainBonus: lvl(levels, 'wind_tunnel') * 0.4,
    upgradeCostScale: Math.max(0.7, 1 - lvl(levels, 'manufacturing') * 0.06),
    upgradeTimeScale: Math.max(0.6, 1 - lvl(levels, 'manufacturing') * 0.08),
    trainingScale: 1 + lvl(levels, 'driver_academy') * 0.08,
    forecastScale: Math.max(0.5, 1 - lvl(levels, 'data_center') * 0.1),
    winterFloorBonus: total * 1.5,
  };
}
