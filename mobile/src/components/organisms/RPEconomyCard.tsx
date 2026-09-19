import { memo } from 'react';
import { View } from 'react-native';
import { colors, glow, spacing } from '@/theme';
import { AppText, GlassCard } from '@/components/atoms';

interface RPEconomyCardProps {
  rp: number;
  weekEarned: number;
}

/**
 * Resource-point counter with the round's delta.
 *
 * The big number and the delta are stacked rather than sat side by side: at
 * this column width a 40px mono figure plus a 24px delta overflows the card
 * and clips both the "+85" and its caption.
 */
export const RPEconomyCard = memo(function RPEconomyCard({ rp, weekEarned }: RPEconomyCardProps) {
  return (
    <GlassCard className="flex-1" contentStyle={{ flex: 1, justifyContent: 'space-between', gap: spacing.md }}>
      <View>
        <AppText variant="labelSmall" color={colors.textTertiary} uppercase numberOfLines={1}>
          Resource Points
        </AppText>
        <View className="mt-1">
          <AppText
            variant="statLarge"
            color={colors.accentLime}
            style={glow.lime}
            numberOfLines={1}
            adjustsFontSizeToFit
          >
            {rp}
          </AppText>
        </View>
      </View>

      <View className="flex-row items-baseline justify-between">
        <AppText variant="labelSmall" color={colors.textTertiary} uppercase numberOfLines={1}>
          This round
        </AppText>
        <AppText variant="stat" color={colors.electricCyan} numberOfLines={1}>
          +{weekEarned}
        </AppText>
      </View>
    </GlassCard>
  );
});
