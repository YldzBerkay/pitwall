import { memo } from 'react';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { colors } from '@/theme';

type Glyph = keyof typeof MaterialCommunityIcons.glyphMap;

/**
 * Semantic icon names used across the app, mapped to MaterialCommunityIcons
 * glyphs. Font-based (@expo/vector-icons) so they always render in Expo.
 * One family, one stroke weight, so the set reads as a single voice.
 */
export type IconName =
  | 'race-week'
  | 'manager'
  | 'development'
  | 'sponsors'
  | 'paddock'
  | 'league'
  | 'profile'
  | 'wind'
  | 'data'
  | 'factory'
  | 'engine'
  | 'academy'
  | 'meeting'
  | 'token'
  | 'alert'
  | 'flag'
  | 'chevron'
  | 'chevron-left'
  | 'menu'
  | 'bolt'
  | 'tyre'
  | 'rain'
  | 'sun'
  | 'clock'
  | 'pit'
  | 'safety'
  | 'target'
  | 'coin'
  | 'gold'
  | 'spy'
  | 'shield'
  | 'driver'
  | 'mechanic'
  | 'strategist'
  | 'timer'
  | 'live'
  | 'info'
  | 'check'
  | 'close'
  | 'trend-up'
  | 'trend-down'
  | 'map'
  | 'settings'
  | 'eye';

const glyphMap: Record<IconName, Glyph> = {
  'race-week': 'flag-checkered',
  manager: 'view-dashboard-variant',
  development: 'wrench',
  sponsors: 'handshake',
  paddock: 'account-group',
  league: 'trophy-variant',
  profile: 'account-circle',
  wind: 'weather-windy',
  data: 'database',
  factory: 'factory',
  engine: 'engine',
  academy: 'school',
  meeting: 'account-group',
  token: 'poker-chip',
  alert: 'alert-decagram',
  flag: 'flag-checkered',
  chevron: 'chevron-right',
  'chevron-left': 'chevron-left',
  menu: 'menu',
  bolt: 'lightning-bolt',
  tyre: 'tire',
  rain: 'weather-pouring',
  sun: 'weather-sunny',
  clock: 'clock-outline',
  pit: 'car-wrench',
  safety: 'car-emergency',
  target: 'bullseye-arrow',
  coin: 'cash',
  gold: 'star-four-points',
  spy: 'incognito',
  shield: 'shield-lock',
  driver: 'racing-helmet',
  mechanic: 'tools',
  strategist: 'head-lightbulb',
  timer: 'timer-outline',
  live: 'access-point',
  info: 'information-outline',
  check: 'check-circle',
  close: 'close-circle',
  'trend-up': 'trending-up',
  'trend-down': 'trending-down',
  map: 'map-marker-path',
  settings: 'cog-outline',
  eye: 'eye-outline',
};

interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
}

export const Icon = memo(function Icon({ name, size = 22, color = colors.textSecondary }: IconProps) {
  return <MaterialCommunityIcons name={glyphMap[name]} size={size} color={color} />;
});
