/**
 * Team value — the "toplam takım fiyatı" figure shown to a player, and the
 * number a finished season's archive will record (that archive screen is a
 * later phase; this module just has to produce the number correctly).
 *
 * This lives on the server, and only here: if the client also derived this
 * figure, the number on a player's screen and the one written into their
 * season history could disagree. One function, pure, no I/O, no database —
 * the next person wiring the season archive should be able to call this with
 * a snapshot of a team's economy row and get the same answer every time.
 *
 * Three components, all expressed in RP so the total reads as one currency:
 *
 * 1. Banked RP — counted one for one, it is already spendable value.
 * 2. Cumulative factory investment — for each known department, the total RP
 *    it took to reach its current level. `departmentCost(level)` prices the
 *    upgrade FROM `level` TO `level + 1`, so the cost of reaching level N is
 *    the sum of `departmentCost(0..N-1)`. A department has no resale value
 *    in the game, but the RP sunk into it is real accumulated worth, so it
 *    counts toward team value. Unknown department codes (not in
 *    `factoryDepartments`) contribute nothing, and a missing or zero level
 *    is treated as no investment.
 * 3. Car premium — the points a car carries above a fresh grid baseline,
 *    times a per-point RP value scaled by `ECONOMY_SCALE` so it moves with
 *    the rest of the economy. Points at or below the baseline contribute
 *    zero for that stat, never a negative.
 */
import { ECONOMY_SCALE } from '@pitwall/shared/economy';
import { departmentCost, factoryDepartments } from '@pitwall/shared/factory';

export interface ValueInput {
  rp: number;
  car: {
    motor: number;
    aero: number;
    grip: number;
  };
  factoryLevels: Record<string, number>;
}

/** A fresh grid car's per-stat baseline; points at or below this add no premium. */
const CAR_BASELINE = 55;

/** RP value of one car stat point above the baseline. */
const CAR_POINT_VALUE = Math.round(120 * ECONOMY_SCALE);

const KNOWN_DEPARTMENTS = new Set(factoryDepartments.map((department) => department.code));

/** Cumulative RP spent to reach `level` (0 if the department was never touched). */
function cumulativeFactoryCost(level: number): number {
  let total = 0;
  for (let current = 0; current < level; current += 1) {
    total += departmentCost(current);
  }
  return total;
}

function factoryValue(factoryLevels: Record<string, number>): number {
  let total = 0;
  for (const [code, level] of Object.entries(factoryLevels)) {
    if (!KNOWN_DEPARTMENTS.has(code)) continue;
    total += cumulativeFactoryCost(Math.max(0, level ?? 0));
  }
  return total;
}

function carPremium(car: ValueInput['car']): number {
  const points =
    Math.max(0, car.motor - CAR_BASELINE) +
    Math.max(0, car.aero - CAR_BASELINE) +
    Math.max(0, car.grip - CAR_BASELINE);
  return points * CAR_POINT_VALUE;
}

export function teamValue(input: ValueInput): number {
  const value = input.rp + factoryValue(input.factoryLevels) + carPremium(input.car);
  return Math.round(value);
}
