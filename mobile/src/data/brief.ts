/**
 * The pit wall briefing — the "commentator" the owner asked for.
 *
 * Before the weekend the engineer reads the circuit, the tyres, the forecast
 * and race control's record, and turns each into one recommendation the
 * manager can either follow or ignore. Following pays: each item followed is
 * worth RP (development money) and career score at settlement, on top of the
 * fact that the recommendations are simply what the race engine rewards.
 *
 * Pure TypeScript. The same function runs on the server so every manager in
 * the league gets the same briefing for the same weekend.
 */

import type { CompoundKey } from './carCustomisation';
import { dryCompoundFor, tyreLifeLaps, type CarSetup, type QualiRisk, type TacticPreset, type WeatherPlan } from './raceEngine';
import { rng } from './rng';
import type { Track } from './tracks';

export type BriefKey = 'tyre' | 'weather' | 'control' | 'overtaking' | 'setup';

/** What the manager actually chose across the weekend, for the compliance check. */
export interface WeekendChoices {
  raceCompound: CompoundKey;
  tactics: TacticPreset;
  risk: QualiRisk;
  bias: number;
}

export interface BriefItem {
  key: BriefKey;
  /** Turkish headline. */
  title: string;
  /** Turkish detail: what the data says. */
  text: string;
  /** Turkish, the concrete call the engineer wants. */
  recommendation: string;
  /** Did the manager's weekend follow this? */
  followed: (choices: WeekendChoices) => boolean;
}

/** RP paid per followed briefing item at settlement. */
export const BRIEF_RP_EACH = 8;

const isWetTyre = (c: CompoundKey) => c === 'INTERMEDIATE' || c === 'WET';

/** Plain Turkish tyre names for the briefing text. */
const tyreName: Record<CompoundKey, string> = { SOFT: 'Yumuşak', MEDIUM: 'Orta', HARD: 'Sert', INTERMEDIATE: 'Geçiş', WET: 'Yağmur' };

/**
 * @param accuracy 0-1 from the strategist: below it, an item may be replaced
 * by a confident but wrong call (seeded on the weekend, so it does not flip).
 * @param seed weekend seed, for the wrong-call draw.
 */
export function briefFor(track: Track, weather: WeatherPlan, setup: CarSetup, accuracy: number = 1, seed: number = 0, forecastBand: number = 0.05): BriefItem[] {
  const items = trueBrief(track, weather, setup, forecastBand);
  if (accuracy >= 1) return items;
  const random = rng(seed * 4451 + 9);
  return items.map((item) => (random() < 1 - accuracy ? wrongCall(item) : item));
}

/** A weak strategist's version: the opposite recommendation, stated with the same confidence. */
function wrongCall(item: BriefItem): BriefItem {
  const flips: Record<BriefKey, Partial<BriefItem>> = {
    tyre: { recommendation: 'Yumuşak lastikle hücum et, tek pit yeter.', followed: (c) => c.raceCompound === 'SOFT' && c.tactics !== 'aggressive' },
    weather: { recommendation: 'Yağmur riski yok sayılır; agresif taktikle git.', followed: (c) => c.tactics === 'aggressive' },
    control: { recommendation: 'Güvenlik aracı beklenmez; erken pit, temkinli taktik.', followed: (c) => c.tactics === 'conservative' },
    overtaking: { recommendation: item.followed({ raceCompound: 'MEDIUM', tactics: 'balanced', risk: 'aggressive', bias: 0 }) ? 'Temkinli tur yeter, grid o kadar önemli değil.' : 'Agresif tur at, grid her şey.', followed: (c) => !item.followed({ ...c }) },
    setup: { recommendation: 'Dengeli ayar en güvenlisi.', followed: (c) => c.bias === 0 },
  };
  return { ...item, ...flips[item.key], key: item.key, title: item.title, text: item.text };
}

function trueBrief(track: Track, weather: WeatherPlan, setup: CarSetup, forecastBand: number): BriefItem[] {
  const items: BriefItem[] = [];
  // A weak strategist reads the sky in a wide band; a strong one to five points.
  const lo = Math.max(0, Math.round((weather.forecast - forecastBand) * 100));
  const hi = Math.min(100, Math.round((weather.forecast + forecastBand) * 100));
  const rainText = lo === hi ? `%${lo}` : `%${lo}-${hi}`;
  const life = { SOFT: tyreLifeLaps('SOFT', track), MEDIUM: tyreLifeLaps('MEDIUM', track), HARD: tyreLifeLaps('HARD', track) };
  const startDry = dryCompoundFor(track.laps, track) === 'HARD' ? 'MEDIUM' : dryCompoundFor(track.laps, track);
  const rain = Math.round(weather.forecast * 100);
  const wetStart = weather.wetAtStart;

  // 1. Tyres: how hard the circuit is on rubber decides the start compound and the stop count.
  const stops = track.attrition >= 0.5 ? 2 : 1;
  items.push({
    key: 'tyre',
    title: 'Lastik aşınması',
    text: `Bu pist lastiği ${track.attrition >= 0.5 ? 'sert' : track.attrition >= 0.35 ? 'orta' : 'hafif'} yiyor: yumuşak ~${life.SOFT}, orta ~${life.MEDIUM}, sert ~${life.HARD} tur dayanır. ${track.laps} turluk yarış için ${stops} pit mantıklı.`,
    recommendation: wetStart
      ? 'Yağmur lastiğiyle başla; pist kuruyunca orta lastiğe geç.'
      : `${tyreName[startDry]} lastikle başla${stops === 2 ? ', agresif taktikle iki pit' : ', dengeli taktikle tek pit'}.`,
    followed: (c) =>
      wetStart
        ? isWetTyre(c.raceCompound)
        : c.raceCompound === startDry && (stops === 2 ? c.tactics === 'aggressive' : c.tactics !== 'aggressive'),
  });

  // 2. Weather: the forecast is the only thing that makes the tyre call risky.
  items.push({
    key: 'weather',
    title: 'Hava',
    text: wetStart
      ? `Pist ıslak başlıyor; yağmur ihtimali ${rainText}. ${weather.dryFromLap ? 'Yarış içinde kuruması bekleniyor.' : 'Gün boyu ıslak kalabilir.'}`
      : `Kuru başlangıç, yarış boyunca yağmur ihtimali ${rainText}. ${rain >= 50 ? 'Sağanak gelirse kuru lastikle tur başına ~6 sn gider.' : 'Kuru lastik güvenli görünüyor.'}`,
    recommendation: wetStart
      ? 'Yağmur lastiğiyle başla, kuruma anında pite hazır ol.'
      : rain >= 50
        ? 'Kuru lastikle başla ama temkinli taktik seç: yağmurda erken tepki.'
        : 'Kuru lastikle başla; yağmur planına gerek yok.',
    followed: (c) => (wetStart ? isWetTyre(c.raceCompound) : rain >= 50 ? !isWetTyre(c.raceCompound) && c.tactics === 'conservative' : !isWetTyre(c.raceCompound)),
  });

  // 3. Race control: a high safety-car chance makes a late stop worth waiting for.
  const sc = Math.round(track.raceControl.sc * 100);
  const vsc = Math.round(track.raceControl.vsc * 100);
  items.push({
    key: 'control',
    title: 'Yarış kontrolü',
    text: `Bu pistte güvenlik aracı ihtimali %${sc}, sanal güvenlik aracı %${vsc}${track.raceControl.red >= 0.15 ? `, kırmızı bayrak %${Math.round(track.raceControl.red * 100)}` : ''}. ${sc >= 55 ? 'Güvenlik aracı altında pit yarı zamana gelir.' : 'Ucuz pit beklemek riskli.'}`,
    recommendation: sc >= 55 ? 'Pit penceresini geç tut: agresif taktik, SC bekle.' : 'Pit penceresini planlı zamanında kullan: dengeli veya temkinli taktik.',
    followed: (c) => (sc >= 55 ? c.tactics === 'aggressive' : c.tactics !== 'aggressive'),
  });

  // 4. Overtaking: where passing is hard, the grid slot is worth a risky lap.
  items.push({
    key: 'overtaking',
    title: 'Geçiş',
    text: track.overtaking <= 0.3
      ? 'Geçiş çok zor: yarış büyük ölçüde gridde kazanılır.'
      : track.overtaking >= 0.65
        ? 'Uzun düzlükler, geçiş kolay: grid sırası az şey ifade eder.'
        : 'Geçiş orta zorlukta.',
    recommendation: track.overtaking <= 0.3 ? 'Sıralamada agresif tur at: ilk sıra çok değerli.' : 'Sıralamada temkinli tur at: gridi riske atmaya değmez.',
    followed: (c) => (track.overtaking <= 0.3 ? c.risk === 'aggressive' : c.risk === 'safe'),
  });

  // 5. Setup: lean the car toward what the circuit pays for.
  const aeroGap = track.demand.aero - track.demand.grip;
  const wantBias = aeroGap > 0.08 ? -1 : aeroGap < -0.08 ? 1 : 0;
  items.push({
    key: 'setup',
    title: 'Araç ayarı',
    text: `Pist isteği: motor gücü %${Math.round(track.demand.motor * 100)}, aerodinamik %${Math.round(track.demand.aero * 100)}, yol tutuş %${Math.round(track.demand.grip * 100)}. Aracımız aerodinamik ${setup.aero}, yol tutuş ${setup.grip}.`,
    recommendation: wantBias < 0 ? 'Ayarı aerodinamiğe yatır (Aero veya Çok aero).' : wantBias > 0 ? 'Ayarı mekanik yol tutuşa yatır (Mekanik veya Çok mekanik).' : 'Dengeli ayar; iki uç da kaybettirir.',
    followed: (c) => (wantBias < 0 ? c.bias < 0 : wantBias > 0 ? c.bias > 0 : c.bias === 0),
  });

  return items;
}

/** How many briefing items the weekend's choices honoured. */
export const briefCompliance = (items: BriefItem[], choices: WeekendChoices): number =>
  items.filter((i) => i.followed(choices)).length;
