/**
 * Ekonomi denge kontrolü.
 *
 * Projede test çerçevesi yok; bu script tasarım spec'inin (§11) ölçülebilir
 * iddialarını koşar. Denge bir görüş meselesi değil, bir eşik meselesi olsun
 * diye her iddia bir aralıkla yazılır.
 *
 *   npm run econ
 */
import { ECONOMY_SCALE } from '../src/data/economy';
import { racePrize } from '../src/data/sponsors';
import { championshipPrize } from '../src/data/season';

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

console.log(failed === 0 ? '\nTÜMÜ GEÇTİ' : `\n${failed} KONTROL BAŞARISIZ`);
process.exit(failed === 0 ? 0 : 1);
