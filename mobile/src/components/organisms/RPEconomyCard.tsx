import { memo } from 'react';
import { View } from 'react-native';
import { colors, glow } from '@/theme';
import { AppText, GlassCard } from '@/components/atoms';

interface RPEconomyCardProps {
  rp: number;
  weekEarned: number;
}

/** Big glowing resource-point counter with the round's delta. */
export const RPEconomyCard = memo(function RPEconomyCard({ rp, weekEarned }: RPEconomyCardProps) {
  return (
    <GlassCard>
      <View className="flex-row items-end justify-between">
        <View>
          <AppText variant="labelSmall" color={colors.textTertiary} uppercase>
            Resource Points
          </AppText>
          <View className="mt-1">
            <AppText variant="statLarge" color={colors.accentBlueLight} style={glow.blue}>
              {rp}
            </AppText>
          </View>
        </View>
        <View className="items-end">
          <AppText variant="stat" color={colors.matrixGreen}>
            +{weekEarned}
          </AppText>
          <AppText variant="labelSmall" color={colors.textTertiary} uppercase>
            This round
          </AppText>
        </View>
      </View>
    </GlassCard>
  );
});
