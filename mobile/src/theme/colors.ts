/**
 * Pit Wall — refined "Deep Space" dark theme.
 * Premium, restrained: near-black navy canvas, solid elevated surfaces,
 * ONE confident blue accent. Green / amber / red appear only to carry meaning.
 */
export const colors = {
  // Backgrounds — near-black navy (never pure black)
  bgDeepSpace: '#0A0E17',
  bgElevated: '#141A28',
  bgSurface2: '#1C2434',
  bgSidebar: 'rgba(15, 20, 33, 0.92)',

  // Surface tokens (kept named "glass" for compatibility; now solid panels)
  glass: '#141A28',
  glassStrong: '#1C2434',
  glassPressed: '#232E43',

  // Single accent (blue) — the only decorative colour
  accentBlue: '#4C82F7',
  accentBlueLight: '#9CBBFF',
  accentSoft: 'rgba(76, 130, 247, 0.15)',

  // Semantic only (muted, meaning-bearing) — cyan/purple fold into the accent
  electricCyan: '#4C82F7',
  cyberPurple: '#9CBBFF',
  matrixGreen: '#3FCF8E',
  neonCoral: '#F0655E',
  solarAmber: '#E3B341',

  // Text
  textPrimary: '#EEF2F9',
  textSecondary: '#9EABC6',
  textTertiary: '#647192',

  // Borders / hairlines
  borderDefault: 'rgba(255, 255, 255, 0.07)',
  borderActive: 'rgba(76, 130, 247, 0.55)',
  borderGlassTop: 'rgba(255, 255, 255, 0.10)',
} as const;

export const gradients = {
  accent: ['#4C82F7', '#9CBBFF'] as const,
  cyan: ['#4C82F7', '#9CBBFF'] as const,
  coral: ['#F0655E', '#E3B341'] as const,
  green: ['#3FCF8E', '#4C82F7'] as const,
  purple: ['#9CBBFF', '#4C82F7'] as const,
  amber: ['#E3B341', '#F0655E'] as const,
  ambient: ['#0E1330', '#0A0E17', '#120C24'] as const,
} as const;

export type ColorToken = keyof typeof colors;
export type GradientToken = keyof typeof gradients;
