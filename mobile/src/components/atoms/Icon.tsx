import { memo } from 'react';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { colors } from '@/theme';

type Glyph = keyof typeof MaterialCommunityIcons.glyphMap;

/**
 * Semantic icon names used across the app, mapped to MaterialCommunityIcons
 * glyphs. Font-based (@expo/vector-icons) so they always render in Expo.
 */
export type IconName =
  | 'race-week'
  | 'manager'
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
  | 'bolt';

const glyphMap: Record<IconName, Glyph> = {
  'race-week': 'calendar-clock',
  manager: 'view-dashboard',
  league: 'trophy',
  profile: 'account-circle',
  wind: 'weather-windy',
  data: 'database',
  factory: 'factory',
  engine: 'gauge',
  academy: 'school',
  meeting: 'account-group',
  token: 'poker-chip',
  alert: 'alert-decagram',
  flag: 'flag-checkered',
  chevron: 'chevron-right',
  'chevron-left': 'chevron-left',
  menu: 'menu',
  bolt: 'lightning-bolt',
};

interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
}

export const Icon = memo(function Icon({ name, size = 22, color = colors.textSecondary }: IconProps) {
  return <MaterialCommunityIcons name={glyphMap[name]} size={size} color={color} />;
});
