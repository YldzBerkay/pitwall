export { colors, gradients } from './colors';
export type { ColorToken, GradientToken } from './colors';
export { fontFamily, typeScale } from './typography';
export type { TypeVariant } from './typography';

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radius = {
  sm: 8,
  md: 14,
  lg: 20,
  xl: 28,
  pill: 999,
} as const;

export const blur = {
  glass: 24,
  sidebar: 40,
  bar: 30,
} as const;

/** Layout constants for the landscape shell (header + collapsible side-nav). */
export const layout = {
  headerHeight: 56,
  navExpanded: 216,
  navCollapsed: 72,
} as const;

/** Outer glow presets (iOS shadow + Android elevation). */
export const glow = {
  blue: {
    shadowColor: '#2563EB',
    shadowOpacity: 0.55,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 0 },
    elevation: 10,
  },
  cyan: {
    shadowColor: '#00F0FF',
    shadowOpacity: 0.5,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  coral: {
    shadowColor: '#FF3366',
    shadowOpacity: 0.45,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  green: {
    shadowColor: '#00FF87',
    shadowOpacity: 0.45,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
} as const;
