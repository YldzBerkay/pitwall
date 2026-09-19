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
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
} as const;

export const blur = {
  glass: 24,
  sidebar: 40,
  bar: 30,
} as const;

/**
 * Layout constants for the landscape shell.
 * Header is full-width; the nav is a compact floating icon capsule anchored
 * to the edge OPPOSITE the dynamic island, vertically centered — never
 * full-height. Only flexible content absorbs the island's safe-area inset.
 */
export const layout = {
  headerHeight: 56,
  /** Width of the floating nav capsule. */
  navCapsuleWidth: 56,
  /** Gap between the capsule and the screen edge (before safe insets). */
  navEdgeGap: 12,
  /** Diameter of a nav icon button inside the capsule. */
  navItemSize: 40,
  /** Height of the portrait bottom tab pill. */
  tabBarHeight: 60,
} as const;

/** Outer glow presets (iOS shadow + Android elevation). */
export const glow = {
  lime: {
    shadowColor: '#D4FF3D',
    shadowOpacity: 0.4,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 0 },
    elevation: 10,
  },
  violet: {
    shadowColor: '#9B5CFF',
    shadowOpacity: 0.45,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  coral: {
    shadowColor: '#FF3B5C',
    shadowOpacity: 0.45,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  teal: {
    shadowColor: '#2DD4BF',
    shadowOpacity: 0.45,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  // Back-compat aliases
  blue: {
    shadowColor: '#D4FF3D',
    shadowOpacity: 0.4,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 0 },
    elevation: 10,
  },
  cyan: {
    shadowColor: '#2DD4BF',
    shadowOpacity: 0.45,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  green: {
    shadowColor: '#2DD4BF',
    shadowOpacity: 0.45,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
} as const;
