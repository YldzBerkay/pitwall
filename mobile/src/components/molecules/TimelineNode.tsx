import { memo } from 'react';
import { View } from 'react-native';
import { colors } from '@/theme';
import { AppText, NeonStatChip } from '@/components/atoms';

interface TimelineNodeProps {
  round: number;
  stat: string;
  amount: string;
  isLast?: boolean;
}

/** A single node on the development-history beam (vertical energy line). */
export const TimelineNode = memo(function TimelineNode({
  round,
  stat,
  amount,
  isLast,
}: TimelineNodeProps) {
  return (
    <View className="flex-row gap-4">
      <View className="w-4 items-center">
        <View
          className="h-3 w-3 rounded-full bg-accent-light"
          style={{
            shadowColor: colors.accentBlue,
            shadowOpacity: 0.9,
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 0 },
            elevation: 5,
          }}
        />
        {!isLast && <View className="mt-0.5 w-0.5 flex-1 bg-border-active" />}
      </View>
      <View className="flex-1 gap-1 pb-6">
        <View className="flex-row items-center justify-between">
          <AppText variant="label" color={colors.textPrimary} uppercase>
            {stat}
          </AppText>
          <NeonStatChip value={amount} tone="positive" />
        </View>
        <AppText variant="labelSmall" color={colors.textTertiary}>
          ROUND {round}
        </AppText>
      </View>
    </View>
  );
});
