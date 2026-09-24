import { View } from 'react-native';
import { colors, spacing } from '@/theme';
import { AppText, GlassCard, Cols } from '@/components/atoms';
import { effectiveStats, setupRiskFactor } from '@pitwall/shared/raceEngine';
import { useGameStore } from '@/store/gameStore';
import { Chip, weekendChoiceErrorText } from './shared';

const BIAS_OPTIONS: { label: string; value: number }[] = [
  { label: 'Aero+', value: -1 },
  { label: 'Aero', value: -0.5 },
  { label: 'Dengeli', value: 0 },
  { label: 'Mekanik', value: 0.5 },
  { label: 'Mekanik+', value: 1 },
];

/**
 * Setup: the manager leans the car toward aero or mechanical grip, and the
 * choice is sent to the server before lights-out.
 *
 * ── WHAT USED TO BE HERE, AND WHY IT IS GONE ──────────────────────────────
 * This panel used to RUN three practice sessions locally (`runPractice`,
 * `simulatePractice`) and show their timing sheets. The server's weekend has
 * no practice sessions: a lobby goes `open` -> `checkin` -> `live`, and
 * qualifying happens once at lights-out. Simulating sessions here would
 * produce lap times from a car the server never ran — a second reality — so
 * the sessions went with the local engine and only the CHOICE remains, which
 * is the part that actually reaches the race.
 */
export function PracticePanel() {
  const weekend = useGameStore((s) => s.weekend);
  const setBias = useGameStore((s) => s.setBias);
  const setup = useGameStore((s) => s.setup);
  const track = useGameStore((s) => s.track());
  // The lobby this device is currently seated in, if any.
  const lobbyId = useGameStore((s) => s.lobby.slots.find((sl) => sl.slotIndex === s.lobby.activeSlotIndex)?.lobbyId ?? undefined);
  const setWeekendChoices = useGameStore((s) => s.setWeekendChoices);
  const weekendChoiceOutcome = useGameStore((s) => s.race.lastWeekendChoiceOutcome);

  // Setup bias is saved before lights-out: it changes what the frozen race
  // recipe will hold, so it is sent immediately, not batched. A `wrong_phase`
  // rejection means the recipe is already frozen for this weekend — the
  // rule working, not a bug — and is surfaced below rather than swallowed.
  const chooseBias = (value: number) => {
    setBias(value);
    if (lobbyId) void setWeekendChoices(lobbyId, { bias: value });
  };

  const eff = effectiveStats(setup());
  const risk = setupRiskFactor(setup(), track);

  return (
    <Cols align="flex-start">
      <GlassCard active className="flex-1" contentStyle={{ gap: spacing.md }}>
        <AppText variant="cardTitle" color={colors.textPrimary}>
          Araç ayarı
        </AppText>
        <AppText variant="bodySmall" color={colors.textSecondary}>
          Kanat açısı, aerodinamik ile mekanik yol tutuş arasında değer kaydırır. Pistin istediği yöne yat.
        </AppText>
        {lobbyId && (
          <AppText variant="labelSmall" color={colors.textTertiary}>
            Işıklar sönmeden önce kaydedilir — sunucu bunu yarış başlarken bir kez okur.
          </AppText>
        )}
        <View className="flex-row gap-1.5">
          {BIAS_OPTIONS.map((o) => (
            <Chip key={o.value} label={o.label} selected={weekend.bias === o.value} onPress={() => chooseBias(o.value)} />
          ))}
        </View>
        {weekendChoiceOutcome?.ok === false && (
          <AppText variant="labelSmall" color={colors.neonCoral}>
            {weekendChoiceErrorText(weekendChoiceOutcome.error)}
          </AppText>
        )}
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
