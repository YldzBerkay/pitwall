import { memo, useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSharedValue } from 'react-native-reanimated';
import { colors } from '@/theme';
import { AppText, Icon, PulseDot } from '@/components/atoms';
import { TrackMap } from '@/features/raceweek/TrackMap';
import { localClock, weekendSchedule, type Track } from '@/data/tracks';

interface NextRaceWidgetProps {
  track: Track;
  round: number;
  totalRounds: number;
  /** Milliseconds until lights out. */
  startsInMs: number;
  /** Where the manager is in the weekend, for the status line. */
  phaseLabel: string;
  onPress?: () => void;
}

function split(ms: number): { d: number; h: string; m: string } {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return { d, h: pad(h), m: pad(m) };
}

/**
 * The next race as a hero: a warm-tinted card with the circuit drawn behind
 * the words, the round number as a big date block, and the countdown split
 * into days / hours / minutes the way the reference schedule does. Tapping
 * takes the manager to the weekend.
 */
export const NextRaceWidget = memo(function NextRaceWidget({ track, round, totalRounds, startsInMs, phaseLabel, onPress }: NextRaceWidgetProps) {
  const [remaining, setRemaining] = useState(startsInMs);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const progress = useSharedValue(1);

  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => setRemaining(Math.max(0, startsInMs - (Date.now() - start))), 30_000);
    return () => clearInterval(id);
  }, [startsInMs]);

  const { d, h, m } = split(remaining);
  const race = weekendSchedule(track).find((s) => s.key === 'RACE');

  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${track.gp} hafta sonuna git`}>
      {({ pressed }) => (
        <View
          className="overflow-hidden rounded-xl"
          style={{ transform: [{ scale: pressed ? 0.99 : 1 }], borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' }}
          onLayout={(e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
        >
          <LinearGradient colors={['#3B2A10', '#1E1A14', '#111214']} start={{ x: 0, y: 0 }} end={{ x: 0.9, y: 1 }} style={{ position: 'absolute', inset: 0 }} />
          {size.w >= 360 && (
            <View pointerEvents="none" style={{ position: 'absolute', right: -14, bottom: 26, opacity: 0.45 }}>
              <TrackMap track={track} progress={progress} width={Math.min(size.w * 0.42, 200)} height={Math.min(size.w * 0.42, 200) * 0.8} />
            </View>
          )}

          <View className="p-4" style={{ gap: 14 }}>
            <View className="flex-row items-center justify-between" style={{ gap: 8 }}>
              <View className="flex-row items-center gap-2" style={{ flexShrink: 1 }}>
                <View className="rounded-sm px-2 py-0.5" style={{ backgroundColor: 'rgba(255,255,255,0.12)' }}>
                  <AppText variant="labelSmall" color={colors.textPrimary} style={{ fontFamily: 'Inter_600SemiBold' }}>
                    {track.country}
                  </AppText>
                </View>
                <AppText variant="labelSmall" color={colors.textSecondary} numberOfLines={1} style={{ flexShrink: 1 }}>
                  {track.sprint ? 'Sprint haftası' : 'Normal hafta'}
                </AppText>
              </View>
              <View className="flex-row items-center gap-1.5 rounded-full px-2 py-0.5" style={{ backgroundColor: 'rgba(255,255,255,0.08)' }}>
                <PulseDot color={colors.accentLime} size={7} periodMs={1400} />
                <AppText variant="labelSmall" color={colors.textPrimary} numberOfLines={1}>
                  {phaseLabel}
                </AppText>
              </View>
            </View>

            <View className="flex-row items-end" style={{ gap: 14 }}>
              <View style={{ width: 64 }}>
                <AppText variant="hero" color={colors.textPrimary} style={{ fontSize: 46, lineHeight: 48 }}>
                  {round}
                </AppText>
                <AppText variant="labelSmall" color={colors.textSecondary} numberOfLines={1}>
                  / {totalRounds} yarış
                </AppText>
              </View>
              <View className="flex-1" style={{ paddingRight: size.w >= 360 ? size.w * 0.16 : 0 }}>
                <AppText variant="sectionTitle" color={colors.textPrimary} numberOfLines={1} style={{ fontSize: 26, lineHeight: 30 }}>
                  {track.gp}
                </AppText>
                <AppText variant="bodySmall" color={colors.textSecondary} numberOfLines={1}>
                  {track.circuit}
                </AppText>
                <AppText variant="labelSmall" color={colors.textTertiary} numberOfLines={1}>
                  {track.label} · {track.laps} tur
                </AppText>
              </View>
            </View>

            <View className="flex-row flex-wrap items-end justify-between" style={{ rowGap: 10 }}>
              <View className="flex-row" style={{ gap: 16 }}>
                <View className="justify-end">
                  <AppText variant="labelSmall" color={colors.textTertiary}>
                    Yarışa{'\n'}kalan
                  </AppText>
                </View>
                <Unit value={`${d}`} label="gün" />
                <Unit value={h} label="saat" />
                <Unit value={m} label="dakika" />
              </View>
              <View className="flex-row items-center gap-1.5">
                <Icon name="clock" size={13} color={colors.textSecondary} />
                <AppText variant="labelSmall" color={colors.textSecondary}>
                  Yarış saati {race ? localClock(race.startUtcMin) : ''}
                </AppText>
              </View>
            </View>
          </View>
        </View>
      )}
    </Pressable>
  );
});

function Unit({ value, label }: { value: string; label: string }) {
  return (
    <View>
      <AppText variant="labelSmall" color={colors.textTertiary}>
        {label}
      </AppText>
      <AppText variant="stat" color={colors.textPrimary} style={{ fontSize: 22, lineHeight: 26 }}>
        {value}
      </AppText>
    </View>
  );
}
