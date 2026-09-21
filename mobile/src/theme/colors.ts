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
  /** Information only — never used for danger (ISO 22324: blue = bilgi, kırmızı = tehlike). */
  infoBlue: '#3FA9FF',

  // Text
  textPrimary: '#F5F6F2',
  textSecondary: '#9A9C9F',
  /** AA kontrastlı (~5.3:1 bgElevated üzerinde) — eski #5C5E63 (~2.7:1) WCAG'ın altındaydı. */
  textTertiary: '#8A8D93',

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

/**
 * Anlam taşıyan HUD renkleri — bu beşi HER ZAMAN bir ikon/şekil/metinle
 * eşlik eder (renk asla tek başına anlam taşımaz), bkz. `useSemanticColors`.
 */
export interface SemanticColors {
  /** Tehlike — kırmızı bayrak, DNF, kritik uyarı. */
  danger: string;
  /** Dikkat — sarı bayrak, SC/VSC, aşınma uyarısı. */
  attention: string;
  /** Onay — en iyi tur, uyum, "hazır". */
  positive: string;
  /** Rekor tur / öne çıkan istatistik (yayın konvansiyonu: mor). */
  record: string;
  /** Sadece bilgilendirme — asla tehlike anlamına gelmez. */
  info: string;
}

export const COLORBLIND_MODES = ['none', 'protanopia', 'deuteranopia', 'tritanopia'] as const;
export type ColorblindMode = (typeof COLORBLIND_MODES)[number];

export const colorblindModeLabels: Record<ColorblindMode, string> = {
  none: 'Kapalı',
  protanopia: 'Protanopi (kırmızı zayıf)',
  deuteranopia: 'Deuteranopi (yeşil zayıf)',
  tritanopia: 'Tritanopi (mavi-sarı zayıf)',
};

/**
 * Her mod için kırmızı/yeşil ayrımının yerini alan mavi/turuncu karşıtlığı
 * (protan/deutan) ya da sarı-mavi ekseni düzeltmesi (tritan). Değerler klinik
 * olarak doğrulanmadı; amaç renk-körü kullanıcı için de "tehlike" ile "onay"
 * arasındaki farkın algılanabilir kalması.
 */
const semanticByMode: Record<ColorblindMode, SemanticColors> = {
  none: {
    danger: colors.neonCoral,
    attention: colors.solarAmber,
    positive: colors.matrixGreen,
    record: colors.accentViolet,
    info: colors.infoBlue,
  },
  protanopia: {
    danger: '#FF8A3D',
    attention: '#FFD400',
    positive: '#3FA9FF',
    record: '#9B5CFF',
    info: '#3FA9FF',
  },
  deuteranopia: {
    danger: '#FF8A3D',
    attention: '#FFD400',
    positive: '#3FA9FF',
    record: '#9B5CFF',
    info: '#3FA9FF',
  },
  tritanopia: {
    danger: colors.neonCoral,
    attention: '#FF8A3D',
    positive: colors.matrixGreen,
    record: '#FF6F91',
    info: '#7DB8FF',
  },
};

export function semanticColors(mode: ColorblindMode): SemanticColors {
  return semanticByMode[mode];
}
