import { colors } from '@/theme';
import type { TrackFit } from '@/data/tracks';
import { playerTeam } from '@/data/teams';

export type { TrackFit };
export type AlertTone = 'blue' | 'amber' | 'red' | 'green' | 'purple';

export const teamState = {
  teamName: 'Bosphorus Apex',
  leagueName: 'Istanbul Constructors',
  round: 7,
  totalRounds: 23,
  rp: 340,
  weekEarned: 85,
  weekSpent: 22,
  seasonProgress: 7 / 23,
  /**
   * Kept only as the seed the first table is built around; the live standing
   * is read off `gameStore.standings`, which the race simulation moves.
   */
  championshipPosition: 6,
  /** Deals already running at the start of the save. */
  startingSponsorships: [
    {
      dealId: 'seed-voltara',
      brandKey: 'bogaz',
      slot: 'sidepod' as const,
      perRace: 89,
      targetPosition: 6,
      bonus: 98,
      signedRound: 3,
      expiresRound: 11,
      streakTarget: 3,
      streak: 1,
    },
    {
      dealId: 'seed-telvana',
      brandKey: 'telvana',
      slot: 'rearWingMain' as const,
      perRace: 51,
      targetPosition: 8,
      bonus: 34,
      signedRound: 5,
      expiresRound: 9,
      streakTarget: 2,
      streak: 0,
    },
  ],
  /**
   * Display-only countdown to lights out. The race itself — circuit, demand,
   * weather — comes from `trackForRound(round)` in `data/tracks.ts`.
   */
  raceStartsInMs: 1000 * 60 * 60 * 52 + 1000 * 60 * 37,
};

export interface CarStat {
  label: string;
  value: number;
  color: string;
  next: string;
  cost: number;
  fit: TrackFit;
}

// Bars share one accent (readability); the LED "fit" dot carries the semantic
// colour. `fit` here is a placeholder: the store recomputes it against the
// upcoming circuit (`withTrackFit`), it is never hand-set.
export const carStats: CarStat[] = [
  { label: 'MOTOR', value: 67, color: colors.accentLime, next: '+2', cost: 15, fit: 'yellow' },
  { label: 'AERO', value: 58, color: colors.accentLime, next: '+2', cost: 15, fit: 'yellow' },
  { label: 'GRIP', value: 72, color: colors.accentLime, next: '+2', cost: 18, fit: 'yellow' },
];

export interface Driver {
  number: number;
  name: string;
  category: 'ROOKIE' | 'EXPERIENCED' | 'ELITE';
  level: number;
  xp: number;
  xpMax: number;
  stats: Record<'PACE' | 'CONSISTENCY' | 'RACECRAFT' | 'WET' | 'REACTION' | 'DEV', number>;
}

const categoryOf = (overall: number): Driver['category'] =>
  overall >= 85 ? 'ELITE' : overall >= 70 ? 'EXPERIENCED' : 'ROOKIE';

/**
 * The player's two drivers as the garage shows them. The names and stats are
 * the same ones the race engine runs (`teams.ts`); level and XP are still
 * placeholders until driver progression exists.
 */
export const drivers: Driver[] = playerTeam.drivers.map((d, i) => ({
  number: d.number,
  name: d.name,
  category: categoryOf(d.skill),
  level: 4 - i,
  xp: i === 0 ? 620 : 450,
  xpMax: i === 0 ? 800 : 500,
  stats: {
    PACE: d.stats.pace,
    CONSISTENCY: d.stats.consistency,
    RACECRAFT: d.stats.racecraft,
    WET: d.stats.wet,
    REACTION: d.stats.reaction,
    DEV: d.stats.dev,
  },
}));

export interface FactoryDepartment {
  code: string;
  icon: string;
  name: string;
  level: number;
  current: string;
  next: string;
  cost: number;
  upgradable: boolean;
}

export const factoryDepartments: FactoryDepartment[] = [
  { code: 'wind_tunnel', icon: 'Wind', name: 'WIND TUNNEL', level: 3, current: 'Aero yükseltme +2 stat', next: '+3 stat + rakip aero görünür', cost: 250, upgradable: true },
  { code: 'data_center', icon: 'Database', name: 'DATA CENTER', level: 2, current: 'Simülasyon +/-%10', next: 'Hava durumu tahmini açılır', cost: 120, upgradable: true },
  { code: 'manufacturing', icon: 'Factory', name: 'MANUFACTURING', level: 2, current: 'Yükseltme maliyeti -%10', next: 'Daha hızlı parça montajı', cost: 120, upgradable: false },
  { code: 'engine_lab', icon: 'Gauge', name: 'ENGINE LAB', level: 1, current: 'Motor jetonu temel oranı', next: 'Jeton bonusu +1', cost: 50, upgradable: true },
  { code: 'driver_academy', icon: 'GraduationCap', name: 'DRIVER ACADEMY', level: 3, current: 'Yarış başına +3 XP', next: 'Rakip pist uyumu görünür', cost: 250, upgradable: false },
];

export interface Alert {
  id: string;
  title: string;
  tone: AlertTone;
  icon: string;
}

// Titles are kept short on purpose: the inbox sits in a narrow column and
// long uppercase strings get truncated mid-word.
export const alerts: Alert[] = [
  { id: 'meeting', title: 'Teknik toplantı hazır', tone: 'blue', icon: 'Users' },
  { id: 'token', title: 'Motor jetonu kazanıldı', tone: 'amber', icon: 'Coins' },
  { id: 'sponsor', title: 'Sözleşme bitiyor', tone: 'red', icon: 'TriangleAlert' },
];

export const upgradeHistory = [
  { round: 6, stat: 'MOTOR', amount: '+2' },
  { round: 5, stat: 'AERO', amount: '+2' },
  { round: 3, stat: 'GRIP', amount: '+1' },
  { round: 2, stat: 'MOTOR', amount: '+1' },
  { round: 1, stat: 'AERO', amount: '+1' },
];
