import { Pressable, View } from 'react-native';
import { colors } from '@/theme';
import { haptic } from '@/lib/haptics';
import { AppText } from './Typography';

interface SegmentTabsProps<K extends string> {
  items: { key: K; label: string }[];
  value: K;
  onChange: (key: K) => void;
  /** Stretch to the container width instead of hugging content. */
  fill?: boolean;
}

/**
 * The "Driver | Team" control from the reference standings: a dark track
 * with one bright pill. Sentence-case labels, one accent, no borders.
 */
export function SegmentTabs<K extends string>({ items, value, onChange, fill }: SegmentTabsProps<K>) {
  return (
    <View
      className="flex-row items-center rounded-full p-1"
      style={{ backgroundColor: 'rgba(255,255,255,0.05)', alignSelf: fill ? 'stretch' : 'flex-start', width: fill ? '100%' : undefined }}
    >
      {items.map((it) => {
        const on = it.key === value;
        return (
          <Pressable
            key={it.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => {
              if (!on) {
                haptic.select();
                onChange(it.key);
              }
            }}
            className="items-center justify-center rounded-full px-3.5 py-1.5"
            style={{ flex: fill ? 1 : undefined, backgroundColor: on ? colors.textPrimary : 'transparent' }}
          >
            <AppText variant="labelSmall" color={on ? colors.bgDeepSpace : colors.textSecondary} style={{ fontFamily: 'Inter_600SemiBold' }}>
              {it.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}
