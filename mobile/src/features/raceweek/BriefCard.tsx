import { View } from 'react-native';
import { colors, spacing } from '@/theme';
import { AppText, GlassCard } from '@/components/atoms';
import { BRIEF_RP_EACH } from '@/data/brief';
import { useGameStore } from '@/store/gameStore';

/**
 * The engineer's briefing: what the data says about this weekend and the call
 * it points to. Each item the manager follows pays RP and career score at
 * settlement, and the card shows live which ones the current choices honour.
 */
export function BriefCard() {
  // Select the function, call it outside the selector: a selector that returns a
  // fresh array every render would re-render forever.
  const briefFn = useGameStore((s) => s.brief);
  const brief = briefFn();
  const weekend = useGameStore((s) => s.weekend);
  const choices = { raceCompound: weekend.raceCompound, tactics: weekend.tactics, risk: weekend.risk, bias: weekend.bias };
  const followed = brief.filter((b) => b.followed(choices)).length;

  return (
    <GlassCard contentStyle={{ gap: spacing.sm }}>
      <View className="flex-row items-center justify-between">
        <AppText variant="cardTitle" color={colors.textPrimary}>
          Mühendis brifingi
        </AppText>
        <AppText variant="labelSmall" color={colors.accentLime} numberOfLines={2} style={{ flexShrink: 1, textAlign: 'right' }}>
          {followed}/{brief.length} öneri tutuyor{'\n'}öneri başına +{BRIEF_RP_EACH} RP
        </AppText>
      </View>
      {brief.map((b) => {
        const ok = b.followed(choices);
        return (
          <View key={b.key} className="flex-row items-start gap-2.5 py-1">
            <View className="mt-1 h-2.5 w-2.5 rounded-full" style={{ backgroundColor: ok ? colors.matrixGreen : colors.textTertiary }} />
            <View className="flex-1">
              <AppText variant="labelSmall" color={colors.textPrimary} style={{ fontFamily: 'Inter_600SemiBold' }}>
                {b.title}
              </AppText>
              <AppText variant="labelSmall" color={colors.textSecondary}>
                {b.text}
              </AppText>
              <AppText variant="labelSmall" color={ok ? colors.matrixGreen : colors.solarAmber}>
                → {b.recommendation}
              </AppText>
            </View>
          </View>
        );
      })}
    </GlassCard>
  );
}
