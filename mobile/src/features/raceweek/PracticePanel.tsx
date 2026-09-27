import { View } from 'react-native';
import { colors, spacing } from '@/theme';
import { AppText, GlassCard, Cols } from '@/components/atoms';
import { effectiveStats, setupRiskFactor } from '@pitwall/shared/raceEngine';
import { useGameStore } from '@/store/gameStore';
import { displayPractice } from '@/store/slices/raceSlice';
import type { PracticeSession } from '@/lib/api/practice';
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
 * ── WHAT USED TO BE HERE, AND WHY IT CAME BACK DIFFERENTLY ────────────────
 * This panel used to RUN three practice sessions locally (`runPractice`,
 * `simulatePractice`) and show their timing sheets. Those calls were removed
 * when practice went away client-side: the server's weekend had no practice
 * sessions of its own yet, and simulating one here would have produced lap
 * times from a car the server never ran — a second reality.
 *
 * The server now runs FP1/FP2/FP3 itself (`server/src/lobby/practice.ts`),
 * freezing the SAME entries every seated player's race uses and deriving one
 * shared classification from them (`derivePracticeResult`) — everyone in the
 * lobby sees the identical sheet, whichever seat they hold. This panel reads
 * that sheet through `displayPractice` (`raceSlice.ts`), which is fed by
 * `race.practice` — filled once the socket's `practiceEvent` announces a
 * session has completed and the slice fetches `GET /lobby/practice`. NO
 * LOCAL FALLBACK: with no lobby, `displayPractice` returns `'no-lobby'` and
 * this panel says so rather than resurrecting a locally-simulated sheet.
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
  const practice = useGameStore((s) => displayPractice(s.race));

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
      <PracticeTimesheetCard practice={practice} />
    </Cols>
  );
}

/**
 * The lap-time sheet itself — where the player checks "how does my car sit
 * against the field on this track" before check-in. Reads `displayPractice`
 * (`raceSlice.ts`) only: no lobby means no sheet at all (never a locally
 * simulated one), and a lobby with nothing frozen yet means "not run" rather
 * than an empty table pretending to be a real, empty session.
 */
function PracticeTimesheetCard({ practice }: { practice: ReturnType<typeof displayPractice> }) {
  if (practice.kind === 'no-lobby') return null;

  return (
    <GlassCard className="flex-1" contentStyle={{ gap: spacing.md }}>
      <AppText variant="cardTitle" color={colors.textPrimary}>
        Pratik
      </AppText>
      {practice.sessions.length === 0 ? (
        <AppText variant="bodySmall" color={colors.textSecondary}>
          Henüz bir pratik seansı koşulmadı — sunucu vakti geldiğinde otomatik başlatır.
        </AppText>
      ) : (
        practice.sessions.map((session) => <PracticeSessionTable key={session.sessionNo} session={session} />)
      )}
    </GlassCard>
  );
}

function PracticeSessionTable({ session }: { session: PracticeSession }) {
  return (
    <View style={{ gap: spacing.xs }}>
      <AppText variant="bodySmall" color={colors.textPrimary}>
        FP{session.sessionNo}{session.wet ? ' — ıslak' : ''}
      </AppText>
      {session.result.order.map((entry, idx) => (
        <View key={`${entry.teamKey}:${entry.driverIdx}`} className="flex-row justify-between">
          <AppText variant="labelSmall" color={colors.textSecondary}>
            {idx + 1}. {entry.driver}
          </AppText>
          <AppText variant="labelSmall" color={colors.textTertiary}>
            {entry.sec.toFixed(3)}s
          </AppText>
        </View>
      ))}
    </View>
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
