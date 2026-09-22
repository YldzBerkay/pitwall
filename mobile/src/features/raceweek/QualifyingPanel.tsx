import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { colors, spacing } from '@/theme';
import { AppText, GlassButton, GlassCard, Cols } from '@/components/atoms';
import { playerTeam } from '@pitwall/shared/teams';
import { tyreLifeLaps, type TacticPreset } from '@pitwall/shared/raceEngine';
import { sprintLaps } from '@pitwall/shared/tracks';

import { useGameStore } from '@/store/gameStore';
import { useShellLayout } from '@/lib/useShellLayout';
import { haptic } from '@/lib/haptics';
import { sfx } from '@/lib/sfx';
import { Chip, CompoundPicker, DriverCell, Pos, fmtSec } from './shared';

const TACTICS: { key: TacticPreset; label: string; hint: string }[] = [
  { key: 'conservative', label: 'Temkinli', hint: 'Erken pit, sert lastik. Az risk, az kazanç.' },
  { key: 'balanced', label: 'Dengeli', hint: 'Lastik %70 aşınınca pit, mesafeye uygun bileşim.' },
  { key: 'aggressive', label: 'Agresif', hint: 'Lastiği sonuna kadar kullan, yumuşak bileşim, fazladan pit.' },
];

/**
 * Qualifying, then the grid.
 *
 * Before the session: tyre and risk. Aggressive buys about three points of
 * pace and throws roughly one lap in seven away. After it: the grid is shown,
 * the manager picks the starting compound, and lights go out.
 */
export function QualifyingPanel({ mode }: { mode: 'race' | 'sprint' }) {
  const weekend = useGameStore((s) => s.weekend);
  const setQualiCompound = useGameStore((s) => s.setQualiCompound);
  const setRisk = useGameStore((s) => s.setRisk);
  const runQualifying = useGameStore((s) => (mode === 'sprint' ? s.runSprintQualifying : s.runQualifying));
  const setRaceCompound = useGameStore((s) => s.setRaceCompound);
  const setTactics = useGameStore((s) => s.setTactics);
  const startRaceSession = useGameStore((s) => (mode === 'sprint' ? s.startSprintSession : s.startRaceSession));
  const track = useGameStore((s) => s.track());
  const shell = useShellLayout();
  const [fullGrid, setFullGrid] = useState(false);

  const sprint = mode === 'sprint';
  const q = sprint ? weekend.sprintQualifying : weekend.qualifying;
  const wetNow = weekend.weather.wetAtStart;
  const raceLaps = sprint ? sprintLaps(track) : track.laps;
  const title = sprint ? 'Sprint' : 'Yarış';

  if (weekend.phase === 'qualifying' || weekend.phase === 'sprintQualifying') {
    return (
      <Cols align="flex-start">
        <GlassCard active className="flex-1" contentStyle={{ gap: spacing.md }}>
          <AppText variant="cardTitle" color={colors.textPrimary}>
            {sprint ? 'Sprint Sıralaması' : 'Sıralama Stratejisi'}
          </AppText>
          <View>
            <AppText variant="labelSmall" color={colors.textTertiary} uppercase className="mb-2">
              Lastik · pist şu an {wetNow ? 'ıslak' : 'kuru'}
            </AppText>
            <CompoundPicker value={weekend.qualiCompound} onChange={setQualiCompound} />
          </View>
          <View>
            <AppText variant="labelSmall" color={colors.textTertiary} uppercase className="mb-2">
              Risk
            </AppText>
            <View className="flex-row gap-1.5">
              <Chip label="Temkinli" selected={weekend.risk === 'safe'} onPress={() => setRisk('safe')} />
              <Chip
                label="Agresif"
                selected={weekend.risk === 'aggressive'}
                tint={colors.neonCoral}
                onPress={() => setRisk('aggressive')}
              />
            </View>
            <AppText variant="bodySmall" color={colors.textTertiary} className="mt-2">
              {weekend.risk === 'aggressive'
                ? 'Daha hızlı tur, ama her yedi turdan biri duvarda biter — ve duvara giden araç seansı kırmızı bayrakla durdurabilir.'
                : 'Temiz tur. Sürpriz yok, kayıp da yok.'}
            </AppText>
          </View>
          <GlassButton
            label={sprint ? 'Sprint sıralamasına çık' : 'Sıralamaya çık'}
            onPress={() => {
              haptic.medium();
              runQualifying();
            }}
          />
        </GlassCard>

        <GlassCard className="flex-1" contentStyle={{ gap: spacing.sm }}>
          <AppText variant="cardTitle" color={colors.textPrimary}>
            {sprint || !weekend.sprintResult ? 'Antrenman özeti' : 'Sprint sonucu'}
          </AppText>
          {(sprint || !weekend.sprintResult) && (
            <AppText variant="labelSmall" color={colors.textTertiary}>
              Seans · en hızlı sürücü · bizim iki aracın sırası
            </AppText>
          )}
          {!sprint && weekend.sprintResult && weekend.sprintResult.order.slice(0, 8).map((e) => (
            <View key={`${e.teamKey}-${e.driverIdx}`} className="flex-row items-center gap-2 py-0.5">
              <Pos n={e.position} lit={e.teamKey === playerTeam.key} />
              <DriverCell entry={e} />
              <AppText variant="labelSmall" color={colors.textTertiary} style={{ fontFamily: 'JetBrainsMono_700Bold' }}>
                +{[8, 7, 6, 5, 4, 3, 2, 1][e.position - 1] ?? 0}p
              </AppText>
            </View>
          ))}
          {weekend.practiceSessions.map((session, i) => {
            const player = session.map((e, idx) => ({ e, idx })).filter(({ e }) => e.teamKey === playerTeam.key);
            const fpRed = weekend.practiceReds[i];
            return (
              <View key={i} className="flex-row items-center gap-2 py-1">
                <Pos n={`A${i + 1}`} width={34} />
                <DriverCell entry={session[0]} />
                <AppText variant="labelSmall" color={colors.accentLime}>
                  {player.map(({ idx }) => `${idx + 1}.`).join(' / ')}
                </AppText>
                {fpRed && (
                  <AppText variant="labelSmall" color={colors.neonCoral}>
                    Kırmızı bayrak
                  </AppText>
                )}
              </View>
            );
          })}
        </GlassCard>
      </Cols>
    );
  }

  if (!q) return null;
  const rows = q.grid.map((e, i) => ({ e, pos: i + 1 }));
  // Narrow screens: the top of the grid plus our two cars, unless expanded.
  const shown = shell.isWide || fullGrid ? rows : rows.filter(({ e, pos }) => pos <= 6 || e.teamKey === playerTeam.key);
  const half = shell.isWide ? Math.ceil(shown.length / 2) : shown.length;
  const columns = shell.isWide ? [shown.slice(0, half), shown.slice(half)] : [shown];
  const startLife = tyreLifeLaps(weekend.raceCompound, track);
  const finishWithoutStop = startLife >= raceLaps;

  const gridCard = (
    <GlassCard contentStyle={{ gap: spacing.sm }}>
      <View className="flex-row items-center justify-between">
        <AppText variant="cardTitle" color={colors.textPrimary}>
          {sprint ? 'Sprint gridi' : 'Başlangıç gridi'}
        </AppText>
        <AppText variant="labelSmall" color={colors.accentLime}>
          {playerTeam.drivers.map((d, i) => `${d.name.split(' ').pop()} ${q.playerGrid[i]}.${q.mistakes[i] ? ' ⚠' : ''}`).join(' · ')}
        </AppText>
      </View>
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

  const actionCard = (
    <GlassCard active contentStyle={{ gap: spacing.md }}>
      <View className="flex-row items-center justify-between">
        <AppText variant="cardTitle" color={colors.textPrimary}>
          {title} başlangıcı
        </AppText>
        {sprint && (
          <AppText variant="labelSmall" color={colors.textTertiary}>
            {`${raceLaps} tur · ilk 8'e 8-7-6-5-4-3-2-1 puan`}
          </AppText>
        )}
      </View>
      <Cols align="flex-start">
        <View className="flex-1">
          <AppText variant="labelSmall" color={colors.textTertiary} uppercase className="mb-2">
            Başlangıç lastiği
          </AppText>
          <CompoundPicker value={weekend.raceCompound} onChange={setRaceCompound} />
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
        <View className="flex-1">
          <AppText variant="labelSmall" color={colors.textTertiary} uppercase className="mb-2">
            Yardımcı bot taktiği
          </AppText>
          <View className="flex-row gap-1.5">
            {TACTICS.map((t) => (
              <Chip key={t.key} label={t.label} selected={weekend.tactics === t.key} onPress={() => setTactics(t.key)} />
            ))}
          </View>
          <AppText variant="bodySmall" color={colors.textTertiary} className="mt-2">
            {TACTICS.find((t) => t.key === weekend.tactics)?.hint} Yarıştan 5 dk önce duvarda değilsen aracı bu taktikle yardımcı yönetir, hata payıyla.
          </AppText>
        </View>
      </Cols>
      <GlassButton
        label={sprint ? 'Sprinti başlat' : 'Yarışı başlat'}
        onPress={() => {
          haptic.heavy();
          sfx.play('spark');
          startRaceSession();
        }}
      />
    </GlassCard>
  );

  return (
    <View style={{ gap: spacing.lg }}>
      {shell.isWide && gridCard}
      {actionCard}
      {!shell.isWide && gridCard}
    </View>
  );
}
