import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSharedValue, withTiming, Easing } from 'react-native-reanimated';
import { colors, spacing } from '@/theme';
import { semanticColors } from '@/theme/colors';
import { AppText, GlassButton, GlassCard, PulseDot, Cols } from '@/components/atoms';
import { GridIntro } from '@/components/organisms';
import { compoundByKey, type CompoundKey } from '@/data/carCustomisation';
import { playerTeam } from '@/data/teams';
import { RACE_TICK_MS, useGameStore } from '@/store/gameStore';
import { haptic } from '@/lib/haptics';
import { useShellLayout } from '@/lib/useShellLayout';
import { sfx } from '@/lib/sfx';
import { TrackMap } from './TrackMap';
import { CompoundDot, CompoundPicker, DriverCell, Pos, fmtGap, fmtSec } from './shared';

/** Height of the map and the leaderboard beside it. */
const MAP_HEIGHT_MAX = 236;

/** A decision moment stays highlighted for this many laps. */
const PROMPT_LAPS = 3;

/**
 * The race, live: map, leaderboard, pit wall.
 *
 * The clock lives in the store and runs at one speed for everyone — no pause,
 * no fast-forward, exactly as it will online. This screen only draws the
 * state and queues pit calls; the map interpolates between the last two laps
 * on the UI thread so the dots keep moving between ticks.
 */
export function LiveRacePanel() {
  const weekend = useGameStore((s) => s.weekend);
  const queuePit = useGameStore((s) => s.queuePit);
  const settleRaceWeekend = useGameStore((s) => s.settleRaceWeekend);
  const finishSprint = useGameStore((s) => s.finishSprint);
  const leagueLive = useGameStore((s) => s.league.connected && s.league.state?.phase === 'live');
  const track = useGameStore((s) => s.track());
  const colorblindMode = useGameStore((s) => s.colorblindMode);
  const semantic = semanticColors(colorblindMode);

  const shell = useShellLayout();
  const MAP_HEIGHT = Math.min(MAP_HEIGHT_MAX, Math.round(shell.height * 0.5));
  const race = weekend.race;
  const prev = weekend.prevRace;
  const [pitCompound, setPitCompound] = useState<[CompoundKey, CompoundKey]>(['MEDIUM', 'MEDIUM']);
  const [mapSize, setMapSize] = useState({ w: 0, h: 0 });
  const progress = useSharedValue(1);
  const lastLap = useRef(-1);
  const [gridVisible, setGridVisible] = useState(false);

  // Auto-dismiss the grid intro — the moment is a taste, not a wait.
  useEffect(() => {
    if (!gridVisible) return;
    const id = setTimeout(() => setGridVisible(false), 2400);
    return () => clearTimeout(id);
  }, [gridVisible]);

  // A new lap arrived: restart the map interpolation and play the cues.
  useEffect(() => {
    if (!race || race.lap === lastLap.current) return;
    lastLap.current = race.lap;
    if (race.lap === 0) {
      // Deferred so the state update isn't synchronous inside the effect body.
      const id = setTimeout(() => setGridVisible(true), 0);
      return () => clearTimeout(id);
    }
    // Full tick length: the next lap's start point is exactly where this
    // animation ends, so the dots never stall and never jump.
    progress.value = 0;
    progress.value = withTiming(1, { duration: RACE_TICK_MS, easing: Easing.linear });
    const fresh = race.events.filter((e) => e.lap === race.lap);
    if (fresh.some((e) => ['rain', 'dry', 'cliff', 'sc', 'vsc', 'red'].includes(e.kind))) haptic.warning();
    if (fresh.some((e) => e.kind === 'pit' && e.teamKey === playerTeam.key)) sfx.play('wrench');
    if (fresh.some((e) => e.kind === 'dnf' && e.teamKey === playerTeam.key)) {
      haptic.error();
      sfx.play('denied');
    }
    if (race.finished) {
      haptic.success();
      sfx.play('partFitted');
    }
  }, [race, progress]);

  if (!race) return null;

  const playerCars = race.cars.filter((c) => c.isPlayer).sort((a, b) => a.driverIdx - b.driverIdx);
  const wetNow = race.wet;
  const prompt = weekend.prompt && race.lap - weekend.prompt.lap < PROMPT_LAPS ? weekend.prompt : undefined;
  const latest = race.events[race.events.length - 1];
  const isSprint = race.session === 'sprint';
  const under = race.neutralised && race.lap < race.neutralised.untilLap ? race.neutralised.kind : undefined;
  const flag = under === 'red'
    ? { text: 'KIRMIZI BAYRAK', colour: semantic.danger }
    : under === 'sc'
      ? { text: 'GÜVENLİK ARACI', colour: semantic.attention }
      : under === 'vsc'
        ? { text: 'SANAL GÜVENLİK ARACI', colour: semantic.attention }
        : latest?.kind === 'yellow' && latest.lap === race.lap
          ? { text: 'SARI BAYRAK', colour: semantic.attention }
          : undefined;

  const mapCard = (
        <GlassCard style={{ flex: 1 }} padded={false}>
          <View className="flex-row items-center justify-between px-3 pt-3">
            <View className="flex-row items-center gap-2">
              {!race.finished && <PulseDot color={semantic.danger} size={8} periodMs={900} />}
              <AppText variant="cardTitle" color={colors.textPrimary}>
                {race.finished ? 'Damalı Bayrak' : `${leagueLive ? 'LİG · ' : ''}${isSprint ? 'Sprint · ' : ''}Tur ${race.lap}/${race.laps}`}
              </AppText>
              {flag && (
                <View className="rounded-sm px-2 py-0.5" style={{ backgroundColor: flag.colour }}>
                  <AppText variant="labelSmall" color={colors.onAccent} uppercase style={{ fontFamily: 'Inter_600SemiBold', fontSize: 10 }}>
                    {flag.text}
                  </AppText>
                </View>
              )}
            </View>
            <AppText variant="labelSmall" color={wetNow ? colors.electricCyan : colors.textTertiary} uppercase>
              {wetNow ? 'Islak pist' : 'Kuru pist'}
              {!wetNow && race.weather.forecast >= 0.3 ? ` · yağmur riski %${Math.round(race.weather.forecast * 100)}` : ''}
            </AppText>
          </View>
          <View style={{ height: MAP_HEIGHT }} onLayout={(e) => setMapSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
            {mapSize.w > 0 && (
              <TrackMap track={track} race={race} prev={prev} progress={progress} width={mapSize.w} height={mapSize.h} />
            )}
          </View>
          <View className="flex-row items-center px-3 pb-3">
            {race.finished && leagueLive ? (
              <AppText variant="labelSmall" color={colors.accentLime} uppercase>
                Lig yarışı bitti · sonuç sunucuda yazıldı
              </AppText>
            ) : race.finished ? (
              <GlassButton
                label={isSprint ? 'Sprint puanlarını kaydet ve sıralamaya geç' : 'Sonuçlar ve kazanç'}
                className="flex-1"
                onPress={() => {
                  haptic.success();
                  if (isSprint) finishSprint();
                  else settleRaceWeekend();
                }}
              />
            ) : (
              <AppText variant="labelSmall" color={colors.textTertiary} numberOfLines={2} style={{ flex: 1 }}>
                Canlı · yaklaşık {Math.max(1, Math.round(((race.laps - race.lap) * RACE_TICK_MS) / 60000))} dk kaldı
                {latest ? ` · Tur ${latest.lap}: ${latest.text}` : ''}
              </AppText>
            )}
          </View>
        </GlassCard>
  );

  const boardCard = (
        <GlassCard className="flex-1">
          <View className="mb-1.5 flex-row items-center justify-between">
            <AppText variant="cardTitle" color={colors.textPrimary}>
              Sıralama
            </AppText>
            {race.fastestLap && (
              <AppText variant="labelSmall" color={semantic.record} numberOfLines={1}>
                En hızlı tur · {race.fastestLap.driver.split(' ').pop()} {fmtSec(race.fastestLap.sec)}
              </AppText>
            )}
          </View>
          <AppText variant="labelSmall" color={colors.textTertiary} className="mb-1">
            Sürücü · lastik · pit sayısı · lidere fark (sn)
          </AppText>
          <ScrollView style={{ height: MAP_HEIGHT + 22 }} showsVerticalScrollIndicator={false}>
            {race.cars.map((c) => (
              <View key={`${c.teamKey}-${c.driverIdx}`} className="flex-row items-center gap-2 py-[3px]" style={{ opacity: c.dnf ? 0.45 : 1 }}>
                <Pos n={c.position} lit={c.isPlayer} width={22} />
                <DriverCell entry={c} dim={c.dnf} showTeam={false} />
                <CompoundDot compound={c.compound} />
                <AppText variant="labelSmall" color={colors.textTertiary} style={{ fontFamily: 'JetBrainsMono_700Bold', width: 14, textAlign: 'right' }}>
                  {c.stops}
                </AppText>
                <AppText variant="labelSmall" color={c.dnf ? semantic.danger : colors.textSecondary} style={{ fontFamily: 'JetBrainsMono_700Bold', width: 54, textAlign: 'right' }}>
                  {c.dnf ? 'Dışı' : c.pitting ? 'Pit' : fmtGap(c.position === 1 ? 0 : c.totalSec - race.cars[0].totalSec)}
                </AppText>
              </View>
            ))}
          </ScrollView>
        </GlassCard>
  );

  const wallCard = (
      <GlassCard active contentStyle={{ gap: spacing.sm }}>
        <View style={{ gap: 2 }}>
          <AppText variant="cardTitle" color={colors.textPrimary}>
            Pit duvarı
          </AppText>
          <AppText variant="labelSmall" color={colors.textTertiary}>
            Çağrı sonraki turda uygulanır · pit kaybı ~{track.pitLossSec} sn{under === 'sc' ? ' (SC altında yarısı)' : under === 'vsc' ? ' (VSC altında %60)' : ''}
          </AppText>
        </View>

        {prompt && (
          <View className="rounded-md border px-3 py-2" style={{ borderColor: semantic.attention, backgroundColor: 'rgba(227,179,65,0.12)' }}>
            <AppText variant="labelSmall" color={semantic.attention} uppercase>
              Tur {prompt.lap} · Karar anı
            </AppText>
            <AppText variant="bodySmall" color={colors.textPrimary}>
              {prompt.text}
            </AppText>
          </View>
        )}

        <Cols gap={spacing.md}>
          {playerCars.map((car) => {
            const idx = car.driverIdx;
            const queued = weekend.pending[idx];
            const wearPct = Math.min(100, Math.round(car.wear * 100));
            const wearTint = car.wear > 0.95 ? semantic.danger : car.wear > 0.75 ? semantic.attention : semantic.positive;
            return (
              <View key={idx} className="flex-1 rounded-md border border-border-default p-2.5" style={{ gap: 8, opacity: car.dnf ? 0.5 : 1 }}>
                <View className="flex-row items-center justify-between gap-2">
                  <AppText variant="label" color={colors.textPrimary} numberOfLines={1} style={{ flexShrink: 1 }}>
                    {car.position}. sıra · {car.driver}
                  </AppText>
                  <CompoundDot compound={car.compound} />
                </View>
                <View className="flex-row items-center justify-between">
                  <AppText variant="labelSmall" color={colors.textTertiary}>
                    Lastik aşınması
                  </AppText>
                  <AppText variant="labelSmall" color={wearTint} style={{ fontFamily: 'JetBrainsMono_700Bold' }}>
                    {car.dnf ? 'Yarış dışı' : `%${wearPct} · ${car.stops} pit`}
                  </AppText>
                </View>
                <View className="h-1.5 overflow-hidden rounded-full" style={{ backgroundColor: 'rgba(255,255,255,0.06)' }}>
                  <View className="h-full rounded-full" style={{ width: `${Math.min(100, wearPct)}%`, backgroundColor: wearTint }} />
                </View>
                {!car.dnf && !race.finished && (
                  <>
                    <CompoundPicker
                      compact
                      value={pitCompound[idx]}
                      onChange={(k) => setPitCompound((p) => (idx === 0 ? [k, p[1]] : [p[0], k]))}
                    />
                    <Pressable
                      onPress={() => {
                        haptic.select();
                        queuePit(idx, queued ? undefined : { compound: pitCompound[idx] });
                      }}
                      className="items-center justify-center rounded-md border py-2"
                      style={{
                        borderColor: queued ? colors.accentLime : colors.borderActive,
                        backgroundColor: queued ? colors.accentLime : colors.accentSoft,
                      }}
                    >
                      <AppText variant="labelSmall" color={queued ? colors.onAccent : colors.accentLime} uppercase style={{ fontFamily: 'Inter_600SemiBold' }}>
                        {queued ? `Pit sırada: ${compoundByKey(queued.compound).label} · iptal et` : 'Pite çağır (box box)'}
                      </AppText>
                    </Pressable>
                  </>
                )}
              </View>
            );
          })}
        </Cols>
      </GlassCard>
  );

  // Portrait: the map, then our two cars (the only controls), then the field.
  // Wide: map and field side by side, the wall underneath.
  return (
    <View style={{ gap: spacing.lg }}>
      {shell.isWide ? (
        <Cols weights={[1.15, 1]}>
          {mapCard}
          {boardCard}
        </Cols>
      ) : (
        <>
          {mapCard}
          {!race.finished && wallCard}
          {boardCard}
        </>
      )}
      {shell.isWide && !race.finished && wallCard}
      {gridVisible && (
        <GridIntro
          cars={race.cars.map((c) => ({ teamKey: c.teamKey, driverIdx: c.driverIdx, driver: c.driver, position: c.position, isPlayer: c.isPlayer }))}
          onDismiss={() => setGridVisible(false)}
        />
      )}
    </View>
  );
}
