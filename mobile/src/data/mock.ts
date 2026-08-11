import { colors } from '@/theme';

export type AlertTone = 'blue' | 'amber' | 'red' | 'green' | 'purple';
export type TrackFit = 'green' | 'yellow' | 'red';

export const teamState = {
  teamName: 'Bosphorus Apex',
  leagueName: 'Istanbul Constructors',
  round: 7,
  totalRounds: 23,
  rp: 340,
  weekEarned: 85,
  weekSpent: 22,
  seasonProgress: 7 / 23,
  nextRace: {
    gp: 'Azerbaijan GP',
    country: 'AZE',
    circuit: 'Baku City Circuit',
    type: 'Street / Power',
    fitScore: 74,
    startsInMs: 1000 * 60 * 60 * 52 + 1000 * 60 * 37,
  },
};

export const sessions = [
  { key: 'FP1', status: 'completed' },
  { key: 'FP2', status: 'completed' },
  { key: 'FP3', status: 'locked' },
  { key: 'Q', status: 'active' },
  { key: 'RACE', status: 'upcoming' },
] as const;

export interface CarStat {
  label: string;
  value: number;
  color: string;
  next: string;
  cost: number;
  fit: TrackFit;
}

// Bars share one accent (readability); the LED "fit" dot carries the semantic colour.
export const carStats: CarStat[] = [
  { label: 'MOTOR', value: 67, color: colors.accentBlue, next: '+2', cost: 15, fit: 'green' },
  { label: 'AERO', value: 58, color: colors.accentBlue, next: '+2', cost: 15, fit: 'yellow' },
  { label: 'GRIP', value: 72, color: colors.accentBlue, next: '+2', cost: 18, fit: 'red' },
];

export interface Driver {
  number: number;
  name: string;
  category: 'ROOKIE' | 'EXPERIENCED' | 'ELITE';
  level: number;
  xp: number;
  xpMax: number;
  stats: Record<'PACE' | 'CONSISTENCY' | 'RACECRAFT' | 'WET' | 'DEV', number>;
}

export const drivers: Driver[] = [
  {
    number: 17,
    name: 'Emir Kaya',
    category: 'ROOKIE',
    level: 3,
    xp: 450,
    xpMax: 500,
    stats: { PACE: 78, CONSISTENCY: 62, RACECRAFT: 71, WET: 44, DEV: 82 },
  },
  {
    number: 28,
    name: 'Mila Arslan',
    category: 'EXPERIENCED',
    level: 4,
    xp: 620,
    xpMax: 800,
    stats: { PACE: 74, CONSISTENCY: 81, RACECRAFT: 69, WET: 66, DEV: 58 },
  },
];

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
  { code: 'wind_tunnel', icon: 'Wind', name: 'WIND TUNNEL', level: 3, current: 'Aero upgrade +2 stat', next: '+3 stat + rival Aero visible', cost: 250, upgradable: true },
  { code: 'data_center', icon: 'Database', name: 'DATA CENTER', level: 2, current: 'Simulation +/-10%', next: 'Weather forecast unlocked', cost: 120, upgradable: true },
  { code: 'manufacturing', icon: 'Factory', name: 'MANUFACTURING', level: 2, current: 'Upgrade cost -10%', next: 'Faster part install', cost: 120, upgradable: false },
  { code: 'engine_lab', icon: 'Gauge', name: 'ENGINE LAB', level: 1, current: 'Motor token baseline', next: 'Token bonus +1', cost: 50, upgradable: true },
  { code: 'driver_academy', icon: 'GraduationCap', name: 'DRIVER ACADEMY', level: 3, current: '+3 XP per race', next: 'Rival track fit visible', cost: 250, upgradable: false },
];

export interface Alert {
  id: string;
  title: string;
  tone: AlertTone;
  icon: string;
}

export const alerts: Alert[] = [
  { id: 'meeting', title: 'TECHNICAL MEETING AVAILABLE', tone: 'blue', icon: 'Users' },
  { id: 'token', title: 'MOTOR TOKEN EARNED', tone: 'amber', icon: 'Coins' },
  { id: 'sponsor', title: 'SPONSOR CONTRACT EXPIRING', tone: 'red', icon: 'TriangleAlert' },
];

export const upgradeHistory = [
  { round: 6, stat: 'MOTOR', amount: '+2' },
  { round: 5, stat: 'AERO', amount: '+2' },
  { round: 3, stat: 'GRIP', amount: '+1' },
  { round: 2, stat: 'MOTOR', amount: '+1' },
  { round: 1, stat: 'AERO', amount: '+1' },
];
