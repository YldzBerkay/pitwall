import { ScrollView, View } from 'react-native';
import { colors, spacing } from '@/theme';
import { AppText, GlassCard, PulseDot, Cols, ScreenHeader } from '@/components/atoms';
import { demandPct, localClock, trackForRound, weekendSchedule, type SessionKey } from '@/data/tracks';
import { TEST_DAYS } from '@/data/season';
import { useGameStore, type WeekendPhase } from '@/store/gameStore';
import { useShellLayout } from '@/lib/useShellLayout';
import { statName } from '@/components/molecules/CarStatCard';
import { PracticePanel } from './PracticePanel';
import { QualifyingPanel } from './QualifyingPanel';
import { LiveRacePanel } from './LiveRacePanel';
import { RaceResultSheet } from './RaceResultSheet';
import { TestingPanel } from './TestingPanel';
import { BriefCard } from './BriefCard';
import { LeagueCard } from './LeagueCard';

type SessionStatus = 'completed' | 'active' | 'upcoming';

const statusLabel: Record<SessionStatus, string> = {
  completed: 'Bitti',
  active: 'Şimdi',
  upcoming: 'Sırada',
};

const sessionName: Record<SessionKey, string> = {
  FP1: 'Antrenman 1',
  FP2: 'Antrenman 2',
  FP3: 'Antrenman 3',
  SQ: 'Sprint S.',
  SPRINT: 'Sprint',
  Q: 'Sıralama',
  RACE: 'Yarış',
};

/** What the manager should do in each phase, in one sentence. */
const phaseHint: Record<WeekendPhase, string> = {
  practice: 'Araç ayarını seç, antrenmanları yap, brifinge bak.',
  sprintQualifying: 'Sprint sıralaması: lastik ve risk seç, tek tur at.',
  sprintGrid: 'Sprint gridi belli. Başlangıç lastiğini seç, sprinti başlat.',
  sprint: 'Sprint canlı: pit çağrıları bir sonraki turda uygulanır.',
  qualifying: 'Sıralama: lastik ve risk seç. Agresif tur hızlı ama riskli.',
  grid: 'Grid belli. Başlangıç lastiğini ve bot taktiğini seç, yarışı başlat.',
  race: 'Yarış canlı: lastik aşınmasını izle, doğru anda pite çağır.',
  result: 'Yarış bitti. Kazanç, başarımlar ve tablo aşağıda.',
};

const fitColour = { green: colors.electricCyan, yellow: colors.solarAmber, red: colors.neonCoral } as const;

/**
 * The race weekend, phase by phase: practice → qualifying → grid → race →
 * result. Everything here reads the store's `weekend`; nothing about the
 * outcome lives in component state, so leaving and returning changes nothing.
 */
export function RaceWeekScreen() {
  const shell = useShellLayout();
  // On the result screen the store already points at the next round; show the race we just ran.
  const currentTrack = useGameStore((s) => s.track());
  const weekend = useGameStore((s) => s.weekend);
  const track = weekend.phase === 'result' ? trackForRound(weekend.round) : currentTrack;
  const carStats = useGameStore((s) => s.carStats);
  const round = useGameStore((s) => s.round);
  const totalRounds = useGameStore((s) => s.totalRounds);
  const season = useGameStore((s) => s.season);
  const testing = useGameStore((s) => s.testing);

  const schedule = weekendSchedule(track);
  const inTesting = testing.day <= TEST_DAYS;
  const sessions = schedule.map((sess) => ({
    ...sess,
    status: sessionStatus(sess.key, weekend.phase, weekend.practiceSessions.length),
  }));
  const demand = demandPct(track);
  const nextKey = sessions.find((s) => s.status === 'upcoming')?.key;
  const forecastPct = Math.round(weekend.weather.forecast * 100);

  // Live race and result: the action goes first, the weekend overview after it.
  const liveFirst = weekend.phase === 'race' || weekend.phase === 'sprint' || weekend.phase === 'result';
  const raceFinished = (weekend.phase === 'race' || weekend.phase === 'sprint') && Boolean(weekend.race?.finished);
  const overview = (
      <Cols weights={[1.4, 1]}>
        <GlassCard style={{ flex: 1 }}>
          <View className="flex-row items-center">
            {sessions.map((s, i) => {
              const done = s.status === 'completed';
              const active = s.status === 'active';
              const lit = done || active;
              return (
                <View key={s.key} className="flex-1 flex-row items-center">
                  <View className="items-center gap-1.5">
                    <View className="h-8 w-8 items-center justify-center">
                      {active && <PulseDot color={colors.accentLime} size={12} />}
                      {!active && (
                        <View
                          className="h-4 w-4 rounded-full border-2"
                          style={{
                            backgroundColor: done ? colors.accentLime : 'transparent',
                            borderColor: done ? colors.accentLime : colors.textTertiary,
                          }}
                        />
                      )}
                    </View>
                    <AppText
                      variant="label"
                      color={lit ? colors.textPrimary : colors.textTertiary}
                      numberOfLines={1}
                      style={{ fontFamily: 'BarlowCondensed_700Bold', letterSpacing: 0.3, fontSize: 12 }}
                    >
                      {sessionName[s.key]}
                    </AppText>
                    <AppText variant="labelSmall" color={active ? colors.accentLime : colors.textTertiary} style={{ fontSize: 10, lineHeight: 12 }}>
                      {active || (s.key === nextKey) ? statusLabel[s.status] : ' '}
                    </AppText>
                    <AppText variant="labelSmall" color={colors.textTertiary} style={{ fontFamily: 'JetBrainsMono_700Bold', fontSize: 10 }}>
                      {localClock(s.startUtcMin)}
                    </AppText>
                  </View>
                  {i < sessions.length - 1 && (
                    <View
                      className="mb-14 h-px flex-1"
                      style={{ backgroundColor: done ? colors.accentLime : 'rgba(255,255,255,0.14)', marginHorizontal: -2 }}
                    />
                  )}
                </View>
              );
            })}
          </View>
        </GlassCard>

        <GlassCard className="flex-1" contentStyle={{ gap: spacing.xs }}>
          <View className="flex-row items-center justify-between">
            <View>
              <AppText variant="cardTitle" color={colors.textPrimary}>
                Pist ne ister
              </AppText>
              <AppText variant="labelSmall" color={colors.textTertiary}>
                Tur zamanını belirleyen paylar · nokta rengi: aracının uyumu · {track.laps} tur{track.sprint ? ' · sprint' : ''}
              </AppText>
            </View>
          </View>
          {carStats.map((s) => {
            const key = s.label.toLowerCase() as keyof typeof demand;
            const pct = demand[key] ?? 0;
            const tint = fitColour[s.fit];
            return (
              <View key={s.label} className="flex-row items-center gap-2.5 py-0.5">
                <View className="h-2 w-2 rounded-full" style={{ backgroundColor: tint }} />
                <AppText variant="labelSmall" color={colors.textSecondary} style={{ width: 88 }}>
                  {statName[s.label] ?? s.label}
                </AppText>
                <View className="h-2 flex-1 overflow-hidden rounded-full" style={{ backgroundColor: 'rgba(255,255,255,0.06)' }}>
                  <View className="h-full rounded-full" style={{ width: `${pct * 1.8}%`, backgroundColor: pct >= 40 ? colors.accentLime : 'rgba(255,255,255,0.35)' }} />
                </View>
                <AppText variant="labelSmall" color={colors.textTertiary} style={{ fontFamily: 'JetBrainsMono_700Bold', width: 30, textAlign: 'right' }}>
                  {pct}%
                </AppText>
              </View>
            );
          })}
          <View className="mt-1 flex-row items-center justify-between">
            <AppText variant="labelSmall" color={colors.textTertiary}>
              Yağmur ihtimali
            </AppText>
            <AppText variant="statSmall" color={colors.textPrimary}>
              %{forecastPct}{weekend.weather.wetAtStart ? ' · şu an ıslak' : ''}
            </AppText>
          </View>
        </GlassCard>
      </Cols>
  );

  return (
    <ScrollView
      className="flex-1"
      contentContainerStyle={{
        paddingTop: shell.contentTop,
        paddingLeft: shell.contentPaddingLeft,
        paddingRight: shell.contentPaddingRight,
        paddingBottom: shell.contentPaddingBottom,
        gap: spacing.lg,
      }}
      showsVerticalScrollIndicator={false}
    >
      <ScreenHeader
        eyebrow={`Sezon ${season} · ${weekend.phase === 'result' ? weekend.round : round}/${totalRounds} yarış · ${track.circuit}`}
        icon="race-week"
        title={track.gp}
        subtitle={raceFinished ? 'Yarış bitti. Sonuçlar ve kazanç hazır.' : phaseHint[weekend.phase]}
      />

      {!liveFirst && overview}

      {inTesting ? (
        <TestingPanel />
      ) : (
        <>
          {weekend.phase === 'practice' && (
            <>
              <PracticePanel />
              <BriefCard />
            </>
          )}
          {(weekend.phase === 'sprintQualifying' || weekend.phase === 'sprintGrid') && <QualifyingPanel mode="sprint" />}
          {(weekend.phase === 'qualifying' || weekend.phase === 'grid') && <QualifyingPanel mode="race" />}
          {(weekend.phase === 'race' || weekend.phase === 'sprint') && <LiveRacePanel />}
          {weekend.phase === 'result' && <RaceResultSheet />}
        </>
      )}
      {liveFirst && overview}
      {!inTesting && weekend.phase !== 'race' && weekend.phase !== 'sprint' && <LeagueCard />}
    </ScrollView>
  );
}

/** Where one scheduled session stands given the weekend's phase. */
function sessionStatus(key: SessionKey, phase: WeekendPhase, practiceDone: number): SessionStatus {
  const order: WeekendPhase[] = ['practice', 'sprintQualifying', 'sprintGrid', 'sprint', 'qualifying', 'grid', 'race', 'result'];
  const at = order.indexOf(phase);
  const after = (p: WeekendPhase) => at > order.indexOf(p);
  const is = (...ps: WeekendPhase[]) => ps.includes(phase);
  switch (key) {
    case 'FP1':
    case 'FP2':
    case 'FP3': {
      const n = Number(key.slice(2));
      if (practiceDone >= n || after('practice')) return 'completed';
      return phase === 'practice' && practiceDone === n - 1 ? 'active' : 'upcoming';
    }
    case 'SQ':
      return is('sprintQualifying') ? 'active' : after('sprintQualifying') ? 'completed' : 'upcoming';
    case 'SPRINT':
      return is('sprintGrid', 'sprint') ? 'active' : after('sprint') ? 'completed' : 'upcoming';
    case 'Q':
      return is('qualifying') ? 'active' : after('qualifying') ? 'completed' : 'upcoming';
    case 'RACE':
      return is('grid', 'race') ? 'active' : phase === 'result' ? 'completed' : 'upcoming';
  }
}
