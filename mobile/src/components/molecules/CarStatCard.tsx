import { memo } from 'react';
import { Pressable, View } from 'react-native';
import { colors } from '@/theme';
import type { TrackFit } from '@/data/mock';
import { AppText, LiquidProgressBar } from '@/components/atoms';
import { haptic } from '@/lib/haptics';

interface CarStatCardProps {
  label: string;
  value: number;
  color: string;
  next: string;
  cost: number;
  fit: TrackFit;
  last?: boolean;
  onUpgrade?: () => void;
}

const fitColor: Record<TrackFit, string> = {
  green: colors.matrixGreen,
  yellow: colors.solarAmber,
  red: colors.neonCoral,
};

export const CarStatCard = memo(function CarStatCard({
  label,
  value,
  color,
  next,
  cost,
  fit,
  last,
  onUpgrade,
}: CarStatCardProps) {
  return (
    <View className={`gap-2 py-3 ${last ? '' : 'border-b border-border-default'}`}>
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          <View
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: fitColor[fit] }}
          />
          <AppText variant="label" color={colors.textSecondary} uppercase>
            {label}
          </AppText>
        </View>
        <AppText variant="stat" color={colors.textPrimary}>
          {value}
        </AppText>
      </View>

      <LiquidProgressBar value={value} colorFrom={color} width={999} className="w-full self-stretch" />

      <View className="flex-row items-center justify-between">
        <AppText variant="labelSmall" color={colors.textTertiary} uppercase>
          Next {next}
        </AppText>
        <Pressable
          className="flex-row items-center gap-1 rounded-md border border-border-active bg-accent-soft px-3 py-1.5"
          onPress={() => {
            haptic.medium();
            onUpgrade?.();
          }}
        >
          <AppText variant="statSmall" color={colors.accentBlueLight}>
            {cost}
          </AppText>
          <AppText variant="labelSmall" color={colors.textSecondary} uppercase>
            RP
          </AppText>
        </Pressable>
      </View>
    </View>
  );
});
