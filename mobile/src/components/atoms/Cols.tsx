import { Children, type PropsWithChildren } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useShellLayout } from '@/lib/useShellLayout';

interface ColsProps {
  /** Override the shell's decision (e.g. force a row for two small tiles). */
  wide?: boolean;
  gap?: number;
  style?: StyleProp<ViewStyle>;
  /** Cross-axis alignment when laid out as a row. */
  align?: 'stretch' | 'flex-start' | 'center';
}

/**
 * Side-by-side on a wide screen, stacked on a narrow one.
 *
 * Children keep their own `flex-1` / `style={{ flex: 1.3 }}` weights: in a
 * row those become column widths, and when stacked each child is wrapped in
 * its own full-width row so the same `flex: 1` fills the width without
 * collapsing the height (a flex-basis-0 child inside a plain column would).
 */
export function Cols({ children, wide, gap, style, align = 'stretch' }: PropsWithChildren<ColsProps>) {
  const shell = useShellLayout();
  const isWide = wide ?? shell.isWide;
  const g = gap ?? shell.gap;
  if (isWide) {
    return (
      <View style={[{ flexDirection: 'row', alignItems: align, gap: g }, style]}>
        {children}
      </View>
    );
  }
  return (
    <View style={[{ gap: g }, style]}>
      {Children.map(children, (child, i) =>
        child == null || child === false ? null : (
          <View key={i} style={{ flexDirection: 'row' }}>
            {child}
          </View>
        ),
      )}
    </View>
  );
}
