import { memo } from 'react';
import { StyleProp, View, ViewStyle } from 'react-native';
import { colors } from '@/theme';
import { AppText } from './Typography';

type Tone = 'positive' | 'negative' | 'neutral' | 'info' | 'warning';

interface NeonStatChipProps {
  value: string;
  tone?: Tone;
  glowing?: boolean;
  className?: string;
  style?: StyleProp<ViewStyle>;
}

const toneColor: Record<Tone, string> = {
  positive: colors.matrixGreen,
  negative: colors.neonCoral,
  neutral: colors.textSecondary,
  info: colors.electricCyan,
  warning: colors.solarAmber,
};

/** Small glowing pill for +/- deltas and tags. */
export const NeonStatChip = memo(function NeonStatChip({
  value,
  tone = 'neutral',
  glowing = true,
  className,
  style,
}: NeonStatChipProps) {
  const color = toneColor[tone];
  return (
    <View
      className={`self-start rounded-full border px-3 py-1 ${className ?? ''}`}
      style={[
        { borderColor: color + '55', backgroundColor: color + '18' },
        glowing && {
          shadowColor: color,
          shadowOpacity: 0.5,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 0 },
          elevation: 4,
        },
        style,
      ]}
    >
      <AppText variant="statSmall" color={color}>
        {value}
      </AppText>
    </View>
  );
});
