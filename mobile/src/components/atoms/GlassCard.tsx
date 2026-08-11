import { PropsWithChildren, memo } from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { colors } from '@/theme';

interface GlassCardProps {
  active?: boolean;
  padded?: boolean;
  className?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * Elevated surface panel. Solid near-black-navy fill, hairline border, a subtle
 * top highlight and a soft drop shadow for depth — clean and legible (replaces
 * the old washed-out blur glass).
 */
export const GlassCard = memo(function GlassCard({
  active,
  padded = true,
  className,
  style,
  children,
}: PropsWithChildren<GlassCardProps>) {
  return (
    <View
      className={`overflow-hidden rounded-lg border bg-elevated ${
        active ? 'border-border-active' : 'border-border-default'
      } ${className ?? ''}`}
      style={[styles.shadow, active && styles.activeGlow, style]}
    >
      <View className="absolute left-0 right-0 top-0 h-px bg-border-top" />
      <View className={padded ? 'p-5' : ''}>{children}</View>
    </View>
  );
});

const styles = StyleSheet.create({
  shadow: {
    shadowColor: '#000000',
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  activeGlow: {
    shadowColor: colors.accentBlue,
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 4 },
    elevation: 10,
  },
});
