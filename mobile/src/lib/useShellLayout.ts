import { useSafeAreaFrame, useSafeAreaInsets } from 'react-native-safe-area-context';
import { layout, spacing } from '@/theme';

/**
 * Shared geometry for the app shell, in both orientations.
 *
 * Portrait: a compact top header and a floating bottom tab bar (the pill
 * every modern sports app uses); content pads for both.
 * Landscape: the same header, but the tab bar becomes a slim vertical capsule
 * on the edge opposite the dynamic island, so the short screen keeps its
 * height for content.
 *
 * `isWide` is what screens use to decide between a two-column row and a
 * single stacked column — see the `Cols` atom.
 */
export function useShellLayout() {
  const insets = useSafeAreaInsets();
  // The frame the app actually draws in. `useWindowDimensions` can report the
  // device's physical orientation while the app is locked to the other one.
  const { width, height } = useSafeAreaFrame();
  const isPortrait = height >= width;
  /** Enough width for side-by-side cards. Tablets in portrait count as wide. */
  const isWide = width >= 700 || (!isPortrait && width >= 640);

  // Landscape: the island sits on the side with the larger inset; nav takes the other.
  const navOnRight = insets.left >= insets.right;
  const sideGutter = layout.navCapsuleWidth + layout.navEdgeGap * 2;
  const bottomBar = layout.tabBarHeight + layout.navEdgeGap * 2;

  const gutter = isPortrait ? spacing.lg : spacing.xl;

  return {
    insets,
    width,
    height,
    isPortrait,
    isWide,
    navOnRight,
    /** Y offset where scrollable content starts (below the header). */
    contentTop: layout.headerHeight + insets.top + spacing.lg,
    contentPaddingLeft: insets.left + (!isPortrait && !navOnRight ? sideGutter : 0) + gutter,
    contentPaddingRight: insets.right + (!isPortrait && navOnRight ? sideGutter : 0) + gutter,
    contentPaddingBottom: insets.bottom + (isPortrait ? bottomBar : 0) + spacing.xl,
    /** Gap between stacked or side-by-side cards. */
    gap: spacing.lg,
  };
}
