import { memo, useEffect, useState } from 'react';
import { View } from 'react-native';
import { colors } from '@/theme';
import { AppText, GlassCard, PulseDot } from '@/components/atoms';

interface NextRaceWidgetProps {
  gp: string;
  country: string;
  circuit: string;
  type: string;
  startsInMs: number;
}

function format(ms: number): { h: string; m: string; s: string } {
  const clamped = Math.max(0, ms);
  const totalSeconds = Math.floor(clamped / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return { h: pad(h), m: pad(m), s: pad(s) };
}

/** Hero countdown card. Segmented HH/MM/SS so it never collapses or clips. */
export const NextRaceWidget = memo(function NextRaceWidget({
  gp,
  country,
  circuit,
  type,
  startsInMs,
}: NextRaceWidgetProps) {
  const [remaining, setRemaining] = useState(startsInMs);

  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => {
      setRemaining(Math.max(0, startsInMs - (Date.now() - start)));
    }, 1000);
    return () => clearInterval(id);
  }, [startsInMs]);

  const { h, m, s } = format(remaining);
  const isFinalMinute = remaining < 60_000;

  return (
    <GlassCard>
      <View className="flex-row items-center justify-between">
        <View className="mr-2 flex-1 flex-row items-center gap-2">
          <View className="rounded-sm border border-border-active px-2 py-1">
            <AppText variant="labelSmall" color={colors.accentBlueLight}>
              {country}
            </AppText>
          </View>
          <AppText variant="cardTitle" color={colors.textPrimary} numberOfLines={1} className="flex-1">
            {gp}
          </AppText>
        </View>
        <PulseDot color={colors.electricCyan} periodMs={isFinalMinute ? 500 : 1400} />
      </View>

      <AppText variant="bodySmall" color={colors.textSecondary} numberOfLines={1} className="mt-2">
        {circuit}
      </AppText>
      <AppText variant="labelSmall" color={colors.textTertiary} uppercase numberOfLines={1}>
        {type}
      </AppText>

      <View className="mt-5 flex-row items-end justify-center">
        <TimeBlock value={h} label="HRS" />
        <Separator />
        <TimeBlock value={m} label="MIN" />
        <Separator />
        <TimeBlock value={s} label="SEC" />
      </View>
      <AppText variant="labelSmall" color={colors.textTertiary} uppercase className="mt-2 text-center">
        Until lights out
      </AppText>
    </GlassCard>
  );
});

function TimeBlock({ value, label }: { value: string; label: string }) {
  return (
    <View className="w-16 items-center">
      <AppText variant="statLarge" color={colors.electricCyan}>
        {value}
      </AppText>
      <AppText variant="labelSmall" color={colors.textTertiary} uppercase>
        {label}
      </AppText>
    </View>
  );
}

function Separator() {
  return (
    <View className="pb-5">
      <AppText variant="stat" color={colors.textTertiary}>
        :
      </AppText>
    </View>
  );
}
