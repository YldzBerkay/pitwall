import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { colors, spacing } from '@/theme';
import { AppText, GlassCard, Cols } from '@/components/atoms';
import { playerTeam } from '@pitwall/shared/teams';
import { tyreLifeLaps, type TacticPreset } from '@pitwall/shared/raceEngine';

import { useGameStore } from '@/store/gameStore';
import { displayQualifying } from '@/store/slices/raceSlice';
import { useShellLayout } from '@/lib/useShellLayout';
import { Chip, CompoundPicker, DriverCell, Pos, compoundLabel, fmtSec, weekendChoiceErrorText } from './shared';

const TACTICS: { key: TacticPreset; label: string; hint: string }[] = [
  { key: 'conservative', label: 'Temkinli', hint: 'Erken pit, sert lastik. Az risk, az kazanç.' },
  { key: 'balanced', label: 'Dengeli', hint: 'Lastik %70 aşınınca pit, mesafeye uygun bileşim.' },
  { key: 'aggressive', label: 'Agresif', hint: 'Lastiği sonuna kadar kullan, yumuşak bileşim, fazladan pit.' },
];

/**
 * The weekend's race choices — tyre, qualifying risk, assistant tactics —
 * and, once the server has published one, the grid those choices produced.
 *
 * ── WHAT USED TO BE HERE, AND WHY IT IS GONE ──────────────────────────────
 * This panel used to RUN qualifying (`runQualifying`/`runSprintQualifying`,
 * `simulateQualifying`) and then START the race (`startRaceSession`,
 * `startRace` plus a client-side lap clock). Neither is the client's to do:
 * the server freezes one recipe at lights-out, runs qualifying from it and
 * ticks the race, broadcasting both. There is no "çık" or "başlat" button
 * because there is nothing for this device to start — the lobby's clock
 * starts it for everyone at once.
 *
 * What remains is exactly the part that reaches the server: the choices,
 * sent immediately (a `wrong_phase` rejection means the recipe is already
 * frozen — the rule working, shown rather than swallowed), and the SERVER's
 * own qualifying result, read through `displayQualifying` with no local
 * fallback.
 */
export function QualifyingPanel() {
  const weekend = useGameStore((s) => s.weekend);
  const setQualiCompound = useGameStore((s) => s.setQualiCompound);
  const setRisk = useGameStore((s) => s.setRisk);
  const setTactics = useGameStore((s) => s.setTactics);
  const track = useGameStore((s) => s.track());
  const shell = useShellLayout();
  const [fullGrid, setFullGrid] = useState(false);

  const lobbyId = useGameStore((s) => s.lobby.slots.find((sl) => sl.slotIndex === s.lobby.activeSlotIndex)?.lobbyId ?? undefined);
  const setWeekendChoices = useGameStore((s) => s.setWeekendChoices);
  const weekendChoiceOutcome = useGameStore((s) => s.race.lastWeekendChoiceOutcome);
  // Server-truth qualifying: see `displayQualifying`'s doc comment for why
  // there is no local fallback while seated in a lobby. The second argument
  // is `undefined` because there is no locally-simulated grid left to pass.
  const raceSlice = useGameStore((s) => s.race);

  const chooseCompound = (key: (typeof weekend)['qualiCompound']) => {
    // One picker, one value: the same tyre starts the qualifying lap and
    // the race (parc fermé) — see `setQualiCompound`'s doc comment.
    setQualiCompound(key);
    if (lobbyId) void setWeekendChoices(lobbyId, { compound: key });
  };
  const chooseRisk = (risk: Parameters<typeof setRisk>[0]) => {
    setRisk(risk);
    if (lobbyId) void setWeekendChoices(lobbyId, { qualiRisk: risk });
  };
  const chooseTactics = (tactics: TacticPreset) => {
    setTactics(tactics);
    if (lobbyId) void setWeekendChoices(lobbyId, { tactics });
  };

  const weekendChoiceNotice = weekendChoiceOutcome?.ok === false ? (
    <AppText variant="labelSmall" color={colors.neonCoral}>
      {weekendChoiceErrorText(weekendChoiceOutcome.error)}
    </AppText>
  ) : null;

  const q = displayQualifying(raceSlice, undefined);
  const wetNow = weekend.weather.wetAtStart;
  const raceLaps = track.laps;
  const startLife = tyreLifeLaps(weekend.raceCompound, track);
  const finishWithoutStop = startLife >= raceLaps;

  const choicesCard = (
    <GlassCard active className="flex-1" contentStyle={{ gap: spacing.md }}>
      <AppText variant="cardTitle" color={colors.textPrimary}>
        Yarış stratejisi
      </AppText>
      <View>
        <AppText variant="labelSmall" color={colors.textTertiary} uppercase className="mb-2">
          Lastik · pist şu an {wetNow ? 'ıslak' : 'kuru'}
        </AppText>
        <AppText variant="labelSmall" color={colors.textTertiary} className="mb-2">
          Bu lastikle hem sıralama turu atılır hem yarışa başlanır.
        </AppText>
        <CompoundPicker value={weekend.qualiCompound} onChange={chooseCompound} />
        <AppText variant="bodySmall" color={colors.textTertiary} className="mt-2">
          {weekend.raceCompound === 'INTERMEDIATE' || weekend.raceCompound === 'WET'
            ? wetNow
              ? 'Islak pist için doğru aile. Kuruyunca pit gerekir.'
              : 'Pist kuru: bu lastik tur başına ~3 sn kaybeder.'
            : wetNow
              ? 'Pist ıslak — slick tur başına ~6 sn kaybeder!'
              : finishWithoutStop
                ? `Kuruda ~${startLife} tur dayanır: ${raceLaps} turu pit yapmadan bitirir.`
                : `Kuruda yaklaşık ${startLife} tur dayanır; sonrası uçurum.`}
        </AppText>
      </View>
      <View>
        <AppText variant="labelSmall" color={colors.textTertiary} uppercase className="mb-2">
          Sıralama riski
        </AppText>
        <View className="flex-row gap-1.5">
          <Chip label="Temkinli" selected={weekend.risk === 'safe'} onPress={() => chooseRisk('safe')} />
          <Chip
            label="Agresif"
            selected={weekend.risk === 'aggressive'}
            tint={colors.neonCoral}
            onPress={() => chooseRisk('aggressive')}
          />
        </View>
        <AppText variant="bodySmall" color={colors.textTertiary} className="mt-2">
          {weekend.risk === 'aggressive'
            ? 'Daha hızlı tur, ama her yedi turdan biri duvarda biter — ve duvara giden araç seansı kırmızı bayrakla durdurabilir.'
            : 'Temiz tur. Sürpriz yok, kayıp da yok.'}
        </AppText>
      </View>
      <View>
        <AppText variant="labelSmall" color={colors.textTertiary} uppercase className="mb-2">
          Yardımcı bot taktiği
        </AppText>
        <View className="flex-row gap-1.5">
          {TACTICS.map((t) => (
            <Chip key={t.key} label={t.label} selected={weekend.tactics === t.key} onPress={() => chooseTactics(t.key)} />
          ))}
        </View>
        <AppText variant="bodySmall" color={colors.textTertiary} className="mt-2">
          {TACTICS.find((t) => t.key === weekend.tactics)?.hint} Yarış sırasında duvarda değilsen aracı bu taktikle yardımcı yönetir, hata payıyla.
        </AppText>
      </View>
      {lobbyId && (
        <AppText variant="labelSmall" color={colors.textTertiary}>
          Işıklar sönmeden önce kaydedilir — sunucu bunu yarış başlarken bir kez okur. Sıralama turu
          ışıklarla birlikte sunucuda atılır; burada başlatılacak bir seans yok.
        </AppText>
      )}
      {weekendChoiceNotice}
    </GlassCard>
  );

  if (!q) return <Cols align="flex-start">{choicesCard}</Cols>;

  const rows = q.grid.map((e, i) => ({ e, pos: i + 1 }));
  // Narrow screens: the top of the grid plus our two cars, unless expanded.
  const shown = shell.isWide || fullGrid ? rows : rows.filter(({ e, pos }) => pos <= 6 || e.teamKey === playerTeam.key);
  const half = shell.isWide ? Math.ceil(shown.length / 2) : shown.length;
  const columns = shell.isWide ? [shown.slice(0, half), shown.slice(half)] : [shown];

  const gridCard = (
    <GlassCard contentStyle={{ gap: spacing.sm }}>
      <View className="flex-row items-center justify-between">
        <AppText variant="cardTitle" color={colors.textPrimary}>
          Başlangıç gridi
        </AppText>
        <AppText variant="labelSmall" color={colors.accentLime}>
          {playerTeam.drivers.map((d, i) => `${d.name.split(' ').pop()} ${q.playerGrid[i]}.${q.mistakes[i] ? ' ⚠' : ''}`).join(' · ')}
        </AppText>
      </View>
      <AppText variant="labelSmall" color={colors.textTertiary}>
        {`${compoundLabel[weekend.raceCompound]} lastikle başlanır · ${raceLaps} tur`}
      </AppText>
      <View className="flex-row" style={{ gap: spacing.lg }}>
        {columns.map((col, c) => (
          <View key={c} className="flex-1">
            {col.map(({ e, pos }) => (
              <View key={`${e.teamKey}-${e.driverIdx}`} className="flex-row items-center gap-2 py-0.5">
                <Pos n={pos} lit={e.teamKey === playerTeam.key} />
                <DriverCell entry={e} />
                <AppText variant="labelSmall" color={colors.textTertiary} numberOfLines={1} style={{ fontFamily: 'JetBrainsMono_700Bold', width: 68, textAlign: 'right' }}>
                  {pos === 1 ? fmtSec(e.sec) : `+${(e.sec - q.grid[0].sec).toFixed(3)}`}
                </AppText>
              </View>
            ))}
          </View>
        ))}
      </View>
      {!shell.isWide && (
        <Pressable onPress={() => setFullGrid((v) => !v)} className="self-start py-1">
          <AppText variant="labelSmall" color={colors.textSecondary}>
            {fullGrid ? 'Daha az göster' : `Tüm gridi göster (${q.grid.length} araç)`}
          </AppText>
        </Pressable>
      )}
      {q.red && (
        <AppText variant="bodySmall" color={colors.neonCoral}>
          {q.red.text}
          {(q.redRuined?.[0] || q.redRuined?.[1]) &&
            ` Bizden ${playerTeam.drivers
              .filter((_, i) => q.redRuined?.[i])
              .map((d) => d.name.split(' ').pop())
              .join(' ve ')} son turunu atamadı.`}
        </AppText>
      )}
      {(q.mistakes[0] || q.mistakes[1]) && (
        <AppText variant="bodySmall" color={colors.neonCoral}>
          Agresif tur duvarda bitti — o araç gridin gerisinden başlıyor.
        </AppText>
      )}
    </GlassCard>
  );

  return (
    <View style={{ gap: spacing.lg }}>
      {shell.isWide && gridCard}
      <Cols align="flex-start">{choicesCard}</Cols>
      {!shell.isWide && gridCard}
    </View>
  );
}
