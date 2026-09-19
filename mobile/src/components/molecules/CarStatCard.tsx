import { memo } from 'react';
import { Pressable, View } from 'react-native';
import { colors } from '@/theme';
import type { TrackFit } from '@/data/mock';
import { AppText, LiquidProgressBar } from '@/components/atoms';
import { haptic } from '@/lib/haptics';

/** Data labels are engine keys; the player sees plain Turkish. */
export const statName: Record<string, string> = { MOTOR: 'Motor gücü', AERO: 'Aerodinamik', GRIP: 'Yol tutuş' };

interface CarStatCardProps {
  label: string;
  value: number;
  color: string;
  next: string;
  cost: number;
  fit: TrackFit;
  last?: boolean;
  /** This stat is on the factory bench — show the countdown instead of the price. */
  building?: boolean;
  /** The part is ready to fit. */
  done?: boolean;
  /** Another stat is being built; the factory is taken. */
  busy?: boolean;
  /** "13 sa 30 dk" — remaining while building, total build time otherwise. */
  timeLabel?: string;
  onUpgrade?: () => void;
  onCollect?: () => void;
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
  building,
  done,
  busy,
  timeLabel,
  onUpgrade,
  onCollect,
}: CarStatCardProps) {
  return (
    <View className={`gap-2 py-3 ${last ? '' : 'border-b border-border-default'}`}>
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          <View
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: fitColor[fit] }}
          />
          <AppText variant="label" color={colors.textSecondary}>
            {statName[label] ?? label}
          </AppText>
        </View>
        <AppText variant="stat" color={colors.textPrimary}>
          {value}
        </AppText>
      </View>

      <LiquidProgressBar value={value} colorFrom={color} colorTo={color} width={999} className="w-full self-stretch" />

      <View className="flex-row items-center justify-between">
        <AppText variant="labelSmall" color={building ? colors.solarAmber : colors.textTertiary} uppercase>
          {building ? (done ? 'Parça hazır' : `Üretimde · ${timeLabel}`) : `Yükseltme ${next} · ${timeLabel}`}
        </AppText>
        {building ? (
          <Pressable
            className="flex-row items-center gap-1 rounded-md border px-3 py-1.5"
            style={{
              borderColor: done ? colors.borderActive : colors.borderDefault,
              backgroundColor: done ? colors.accentSoft : 'transparent',
              opacity: done ? 1 : 0.6,
            }}
            disabled={!done}
            onPress={() => {
              haptic.success();
              onCollect?.();
            }}
          >
            <AppText
              variant="labelSmall"
              color={done ? colors.accentLime : colors.textSecondary}
              style={{ fontFamily: 'Inter_600SemiBold' }}
            >
              {done ? 'Parçayı Tak' : 'Sürüyor…'}
            </AppText>
          </Pressable>
        ) : (
          <Pressable
            className="flex-row items-center gap-1 rounded-md border px-3 py-1.5"
            style={{
              borderColor: busy ? colors.borderDefault : colors.borderActive,
              backgroundColor: busy ? 'transparent' : colors.accentSoft,
              opacity: busy ? 0.5 : 1,
            }}
            disabled={busy}
            onPress={() => {
              haptic.medium();
              onUpgrade?.();
            }}
          >
            <AppText variant="labelSmall" color={colors.accentLime} style={{ fontFamily: 'Inter_600SemiBold' }}>
              Yükselt
            </AppText>
            <AppText variant="statSmall" color={colors.accentLime}>
              {cost}
            </AppText>
            <AppText variant="labelSmall" color={colors.textSecondary}>
              RP
            </AppText>
          </Pressable>
        )}
      </View>
    </View>
  );
});
