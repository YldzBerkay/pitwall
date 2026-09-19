/**
 * Pit Wall — "Night Circuit" dark theme (landscape shell reference).
 * Near-black graphite canvas, solid elevated panels, ONE loud acid-lime
 * accent with a violet support. Teal / amber / pink appear only to carry
 * meaning (fit, warnings, danger).
 */
export const colors = {
  // Backgrounds — graphite, never pure black
  bgDeepSpace: '#0B0C0F',
  bgElevated: '#17181C',
  bgSurface2: '#1F2024',
  bgSidebar: 'rgba(23, 24, 28, 0.92)',

  // Surface tokens (kept named "glass" for compatibility; solid panels)
  glass: '#17181C',
  glassStrong: '#1F2024',
  glassPressed: '#26272C',

  // Primary accent — acid lime; violet as the gradient partner
  accentLime: '#D4FF3D',
  accentViolet: '#9B5CFF',
  accentSoft: 'rgba(212, 255, 61, 0.12)',
  /** Text/icon color placed ON an acid-lime surface. */
  onAccent: '#14151A',

  // Back-compat aliases (old names used across components)
  accentBlue: '#D4FF3D',
  accentBlueLight: '#D4FF3D',
  electricCyan: '#2DD4BF',
  cyberPurple: '#9B5CFF',
  matrixGreen: '#2DD4BF',
  neonCoral: '#FF3B5C',
  solarAmber: '#E3B341',

  // Text
  textPrimary: '#F5F6F2',
  textSecondary: '#9A9C9F',
  textTertiary: '#5C5E63',

  // Borders / hairlines
  borderDefault: 'rgba(255, 255, 255, 0.08)',
  borderActive: 'rgba(212, 255, 61, 0.5)',
  borderGlassTop: 'rgba(255, 255, 255, 0.10)',
} as const;

export const gradients = {
  accent: ['#D4FF3D', '#9B5CFF'] as const,
  cyan: ['#D4FF3D', '#9B5CFF'] as const,
  coral: ['#FF3B5C', '#E3B341'] as const,
  green: ['#2DD4BF', '#D4FF3D'] as const,
  purple: ['#9B5CFF', '#D4FF3D'] as const,
  amber: ['#E3B341', '#FF3B5C'] as const,
  /** Setup-bias track: aero (pink) → mechanical (lime). */
  bias: ['#FF3B5C', '#D4FF3D'] as const,
  ambient: ['#14150F', '#0B0C0F', '#141019'] as const,
} as const;

export type ColorToken = keyof typeof colors;
export type GradientToken = keyof typeof gradients;
