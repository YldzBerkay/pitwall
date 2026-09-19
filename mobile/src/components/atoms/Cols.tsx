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
  /**
   * Relative column widths when laid out as a row, one per child — `[1.3, 1]`
   * gives the first column 30% more space. Defaults to equal columns.
   */
  weights?: number[];
}

/**
 * Side-by-side on a wide screen, stacked on a narrow one.
 *
 * Every child is wrapped in its own row, in BOTH orientations: stacked, that
 * row is what lets a `flex-1` child fill the width without collapsing its
 * height (a flex-basis-0 child inside a plain column would); side by side,
 * that same row is the column itself and carries the child's `weights` share.
 *
 * Keeping one shape for both orientations is deliberate: if the element tree
 * changed on rotation, React would unmount and remount everything inside —
 * and tearing down a live Filament scene (the car turntable) mid-rotation
 * aborts the app in Filament's material-instance destructor.
 */
export function Cols({ children, wide, gap, style, align = 'stretch', weights }: PropsWithChildren<ColsProps>) {
  const shell = useShellLayout();
  const isWide = wide ?? shell.isWide;
  const g = gap ?? shell.gap;
  const items = Children.toArray(children).filter(Boolean);

  return (
    <View
      style={[
        { flexDirection: isWide ? 'row' : 'column', alignItems: isWide ? align : 'stretch', gap: g },
        style,
      ]}
    >
      {items.map((child, i) => (
        <View
          key={i}
          style={
            isWide
              ? { flexDirection: 'row', flexGrow: weights?.[i] ?? 1, flexShrink: 1, flexBasis: 0 }
              : { flexDirection: 'row' }
          }
        >
          {child}
        </View>
      ))}
    </View>
  );
}
