/**
 * Typography tokens. Line-heights are boosted ~15% to avoid a
 * claustrophobic feel (2026 "airy" spec).
 *
 * - Headings: Barlow Condensed (Bold / ExtraBold), uppercase, wide tracking
 * - Body/labels: Inter (Regular / Medium / SemiBold)
 * - Numbers/stats/timers/currency: JetBrains Mono Bold
 */
export const fontFamily = {
  displayBold: 'BarlowCondensed_700Bold',
  displayExtra: 'BarlowCondensed_800ExtraBold',
  body: 'Inter_400Regular',
  bodyMedium: 'Inter_500Medium',
  bodySemi: 'Inter_600SemiBold',
  mono: 'JetBrainsMono_700Bold',
} as const;

const LINE_HEIGHT_BOOST = 1.15;

const lh = (size: number, ratio = 1.2) => Math.round(size * ratio * LINE_HEIGHT_BOOST);

export const typeScale = {
  hero: { fontFamily: fontFamily.displayExtra, fontSize: 38, lineHeight: lh(38), letterSpacing: 1.2 },
  pageTitle: { fontFamily: fontFamily.displayBold, fontSize: 28, lineHeight: lh(28), letterSpacing: 1.2 },
  sectionTitle: { fontFamily: fontFamily.displayBold, fontSize: 22, lineHeight: lh(22), letterSpacing: 1 },
  cardTitle: { fontFamily: fontFamily.displayBold, fontSize: 19, lineHeight: lh(19), letterSpacing: 0.6 },
  // Body/label minimums raised (≥12px) per readability guidance.
  label: { fontFamily: fontFamily.bodySemi, fontSize: 14, lineHeight: lh(14, 1.4), letterSpacing: 0.4 },
  labelSmall: { fontFamily: fontFamily.bodyMedium, fontSize: 12, lineHeight: lh(12, 1.4), letterSpacing: 0.6 },
  body: { fontFamily: fontFamily.body, fontSize: 16, lineHeight: lh(16, 1.5) },
  bodySmall: { fontFamily: fontFamily.body, fontSize: 14, lineHeight: lh(14, 1.5) },
  statLarge: { fontFamily: fontFamily.mono, fontSize: 40, lineHeight: lh(40, 1.05), letterSpacing: -1 },
  stat: { fontFamily: fontFamily.mono, fontSize: 24, lineHeight: lh(24, 1.1) },
  statSmall: { fontFamily: fontFamily.mono, fontSize: 16, lineHeight: lh(16, 1.1) },
} as const;

export type TypeVariant = keyof typeof typeScale;
