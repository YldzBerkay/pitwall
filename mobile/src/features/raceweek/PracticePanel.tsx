import { View } from 'react-native';
import { colors, spacing } from '@/theme';
import { AppText, GlassButton, GlassCard, Cols } from '@/components/atoms';
import { playerTeam } from '@/data/teams';
import { carId, effectiveStats, setupRiskFactor } from '@/data/raceEngine';
import { useGameStore } from '@/store/gameStore';
import { haptic } from '@/lib/haptics';
import { Chip, DriverCell, Pos, fmtSec } from './shared';

const BIAS_OPTIONS: { label: string; value: number }[] = [
  { label: 'Aero+', value: -1 },
  { label: 'Aero', value: -0.5 },
  { label: 'Dengeli', value: 0 },
  { label: 'Mekanik', value: 0.5 },
  { label: 'Mekanik+', value: 1 },
];

/**
 * Practice: the manager leans the setup toward aero or mechanical grip and
 * runs three sessions to see where that lands the car. The sessions are
 * noisy on purpose — a hint, not a verdict — and leading all three is a leg
 * of the Clean Sweep.
 */
export function PracticePanel() {
  const weekend = useGameStore((s) => s.weekend);
  const setBias = useGameStore((s) => s.setBias);
  const runPractice = useGameStore((s) => s.runPractice);
  const setup = useGameStore((s) => s.setup);
  const track = useGameStore((s) => s.track());

  const eff = effectiveStats(setup());
  const risk = setupRiskFactor(setup(), track);
  const nextSession = weekend.practiceSessions.length + 1;
  const last = weekend.practice;
  const playerRows = last.map((e, i) => ({ e, i })).filter(({ e }) => e.teamKey === playerTeam.key);
  const red = weekend.practiceReds[weekend.practiceReds.length - 1];
  const redHitUs = red ? playerRows.filter(({ e }) => red.ruined.includes(carId(e))).map(({ e }) => e.driver) : [];

  return (
    <Cols align="flex-start">
      <GlassCard active className="flex-1" contentStyle={{ gap: spacing.md }}>
        <AppText variant="cardTitle" color={colors.textPrimary}>
          Araç ayarı ve antrenman
        </AppText>
        <AppText variant="bodySmall" color={colors.textSecondary}>
          Kanat açısı, aerodinamik ile mekanik yol tutuş arasında değer kaydırır. Pistin istediği yöne yat.
        </AppText>
        <View className="flex-row gap-1.5">
          {BIAS_OPTIONS.map((o) => (
            <Chip key={o.value} label={o.label} selected={weekend.bias === o.value} onPress={() => setBias(o.value)} />
          ))}
        </View>
        {risk > 1 && (
          <AppText variant="labelSmall" color={risk >= 1.6 ? colors.neonCoral : colors.solarAmber}>
            Uç setup: kaza ve hata riski ×{risk.toFixed(1)}{risk >= 1.6 ? ' — pistin istediğinin tersine yatırılmış' : ''}.
          </AppText>
        )}
        <View className="flex-row justify-around">
          <StatDelta label="Motor gücü" value={eff.motor} base={setup().motor} />
          <StatDelta label="Aerodinamik" value={eff.aero} base={setup().aero} />
          <StatDelta label="Yol tutuş" value={eff.grip} base={setup().grip} />
        </View>
        <GlassButton
          label={nextSession <= 3 ? `${nextSession}. antrenmanı yap` : 'Antrenman tamamlandı'}
          disabled={nextSession > 3}
          onPress={() => {
            haptic.medium();
            runPractice();
          }}
        />
        {playerRows.length > 0 && (
          <AppText variant="labelSmall" color={colors.textSecondary}>
            {`Son seans: ${playerRows.map(({ e, i }) => `${e.driver.split(' ').pop()} ${i + 1}.`).join(' · ')}${redHitUs.length ? ' · kırmızı bayrak' : ''} · ${3 - weekend.practiceSessions.length} seans kaldı`}
          </AppText>
        )}
      </GlassCard>

      <GlassCard className="flex-1" contentStyle={{ gap: spacing.sm }}>
        <View className="flex-row items-center justify-between">
          <AppText variant="cardTitle" color={colors.textPrimary}>
            {weekend.practiceSessions.length ? `${weekend.practiceSessions.length}. antrenman sonuçları` : 'Zaman tablosu'}
          </AppText>
        </View>
        {red && (
          <AppText variant="bodySmall" color={colors.neonCoral}>
            {red.text}
            {redHitUs.length > 0 && ` Bizden ${redHitUs.map((n) => n.split(' ').pop()).join(' ve ')} turunu kaybetti.`}
          </AppText>
        )}
        {last.length === 0 && (
          <AppText variant="bodySmall" color={colors.textTertiary}>
            {'Henüz tur atılmadı. Araç ayarını seç, 1. antrenmanı yap.'}
          </AppText>
        )}
        {last.slice(0, 8).map((e, i) => (
          <View key={`${e.teamKey}-${e.driverIdx}`} className="flex-row items-center gap-2 py-0.5">
            <Pos n={i + 1} lit={e.teamKey === playerTeam.key} />
            <DriverCell entry={e} />
            <AppText variant="labelSmall" color={colors.textSecondary} style={{ fontFamily: 'JetBrainsMono_700Bold', width: 64, textAlign: 'right' }}>
              {i === 0 ? fmtSec(e.sec) : `+${(e.sec - last[0].sec).toFixed(3)}`}
            </AppText>
          </View>
        ))}
        {playerRows.filter(({ i }) => i >= 8).map(({ e, i }) => (
          <View key={`${e.teamKey}-${e.driverIdx}`} className="flex-row items-center gap-2 border-t border-border-default py-0.5 pt-1.5">
            <Pos n={i + 1} lit />
            <DriverCell entry={e} />
            <AppText variant="labelSmall" color={colors.textSecondary} style={{ fontFamily: 'JetBrainsMono_700Bold', width: 64, textAlign: 'right' }}>
              +{(e.sec - last[0].sec).toFixed(3)}
            </AppText>
          </View>
        ))}
      </GlassCard>
    </Cols>
  );
}

function StatDelta({ label, value, base }: { label: string; value: number; base: number }) {
  const d = value - base;
  const tint = d > 0 ? colors.matrixGreen : d < 0 ? colors.neonCoral : colors.textSecondary;
  return (
    <View className="items-center">
      <AppText variant="stat" color={colors.textPrimary}>
        {Math.round(value)}
      </AppText>
      <AppText variant="labelSmall" color={colors.textTertiary}>
        {label}
      </AppText>
      <AppText variant="labelSmall" color={tint}>
        {d === 0 ? '±0' : `${d > 0 ? '+' : ''}${d}`}
      </AppText>
    </View>
  );
}
