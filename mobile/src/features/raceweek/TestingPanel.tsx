import { View } from 'react-native';
import { colors, spacing } from '@/theme';
import { AppText, GlassButton, GlassCard, Cols } from '@/components/atoms';
import { TEST_DAYS, type TestFocus } from '@/data/season';
import { useGameStore } from '@/store/gameStore';
import { haptic } from '@/lib/haptics';
import { sfx } from '@/lib/sfx';
import { Chip } from './shared';
import { useState } from 'react';

const PROGRAMMES: { key: TestFocus; label: string; hint: string }[] = [
  { key: 'motor', label: 'MOTOR', hint: 'Güç ünitesi haritaları, uzun düzlük hızı.' },
  { key: 'aero', label: 'AERO', hint: 'Kanat paketleri, yüksek hızlı viraj yükü.' },
  { key: 'grip', label: 'GRIP', hint: 'Süspansiyon, mekanik tutuş, yavaş virajlar.' },
  { key: 'reliability', label: 'GÜVENİLİRLİK', hint: 'Uzun koşular, parça ömrü; fabrika seviyesi.' },
];

/**
 * Pre-season testing: three days, one programme a day. The engineer says
 * where the car is weakest against the calendar; the programme that matches
 * develops the car twice as fast. Wrong programmes still help, just less.
 */
export function TestingPanel() {
  const testing = useGameStore((s) => s.testing);
  const testReportFn = useGameStore((s) => s.testReport);
  const report = testReportFn();
  const runTestDay = useGameStore((s) => s.runTestDay);
  const season = useGameStore((s) => s.season);
  const [choice, setChoice] = useState<TestFocus>('motor');

  if (!report) return null;
  const last = testing.outcomes[testing.outcomes.length - 1];

  return (
    <Cols align="flex-start">
      <GlassCard active className="flex-1" contentStyle={{ gap: spacing.md }}>
        <View className="flex-row items-center justify-between">
          <AppText variant="cardTitle" color={colors.textPrimary}>
            Sezon {season} · Test Günü {report.day}/{TEST_DAYS}
          </AppText>
          <AppText variant="labelSmall" color={colors.textTertiary} uppercase>
            Sezon öncesi test
          </AppText>
        </View>
        <View className="rounded-md border px-3 py-2" style={{ borderColor: colors.borderActive, backgroundColor: colors.accentSoft }}>
          <AppText variant="labelSmall" color={colors.accentLime} uppercase>
            Mühendis raporu
          </AppText>
          <AppText variant="bodySmall" color={colors.textPrimary}>
            {report.text}
          </AppText>
        </View>
        <View>
          <AppText variant="labelSmall" color={colors.textTertiary} uppercase className="mb-2">
            Test programı
          </AppText>
          <View className="flex-row gap-1.5">
            {PROGRAMMES.map((p) => (
              <Chip key={p.key} label={p.label} selected={choice === p.key} onPress={() => setChoice(p.key)} />
            ))}
          </View>
          <AppText variant="bodySmall" color={colors.textTertiary} className="mt-2">
            {PROGRAMMES.find((p) => p.key === choice)?.hint} Rapora uyan program +2 stat, uymayan +1.
          </AppText>
        </View>
        <GlassButton
          label={`Gün ${report.day} — Testi Koştur`}
          onPress={() => {
            const outcome = runTestDay(choice);
            if (outcome?.correct) {
              haptic.success();
              sfx.play('partFitted');
            } else {
              haptic.medium();
              sfx.play('wrench');
            }
          }}
        />
      </GlassCard>

      <GlassCard className="flex-1" contentStyle={{ gap: spacing.sm }}>
        <AppText variant="cardTitle" color={colors.textPrimary}>
          Test Günlüğü
        </AppText>
        {testing.outcomes.length === 0 && (
          <AppText variant="bodySmall" color={colors.textTertiary}>
            Henüz koşu yok. Rapor doğru okunursa araç iki kat hızlı gelişir.
          </AppText>
        )}
        {testing.outcomes.map((o) => (
          <View key={o.day} className="flex-row items-center justify-between py-1">
            <AppText variant="labelSmall" color={colors.textSecondary}>
              Gün {o.day} · {PROGRAMMES.find((p) => p.key === o.chosen)?.label}
            </AppText>
            <AppText variant="labelSmall" color={o.correct ? colors.matrixGreen : colors.solarAmber} style={{ fontFamily: 'JetBrainsMono_700Bold' }}>
              {o.correct ? `doğru hamle · +${o.gain}` : `+${o.gain}`}
            </AppText>
          </View>
        ))}
        {last && (
          <AppText variant="bodySmall" color={colors.textTertiary}>
            {last.correct ? 'Mühendis memnun: rapor doğru okundu.' : 'Program çalıştı ama rapordaki zayıflığa değmedi.'}
          </AppText>
        )}
      </GlassCard>
    </Cols>
  );
}
