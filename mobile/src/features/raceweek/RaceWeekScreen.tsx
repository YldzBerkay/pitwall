import { useEffect } from 'react';
import { ScrollView, View } from 'react-native';
import { colors, spacing } from '@/theme';
import { AppText, GlassButton, GlassCard, PulseDot, Cols, ScreenHeader } from '@/components/atoms';
import { demandPct, localClock, trackForRound, weekendSchedule, type SessionKey } from '@pitwall/shared/tracks';
import { TEST_DAYS } from '@pitwall/shared/season';
import { useGameStore } from '@/store/gameStore';
import { displayPhase, displayWeekPanel, type WeekPanel } from '@/store/slices/raceSlice';
import { useShellLayout } from '@/lib/useShellLayout';
import { haptic } from '@/lib/haptics';
import { statName } from '@/components/molecules/CarStatCard';
import { PracticePanel } from './PracticePanel';
import { QualifyingPanel } from './QualifyingPanel';
import { LiveRacePanel } from './LiveRacePanel';
import { RaceResultSheet } from './RaceResultSheet';
import { TestingPanel } from './TestingPanel';
import { BriefCard } from './BriefCard';
import { LeagueCard } from './LeagueCard';
import { weekPanelLabel, weekendChoiceErrorText } from './shared';

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

/** What the manager should do in each panel, in one sentence. */
const panelHint: Record<WeekPanel, string> = {
  'no-lobby': 'Bir lige katıl — hafta sonu orada, sunucunun saatinde koşulur.',
  loading: 'Lobi durumu sunucudan alınıyor…',
  choices: 'Araç ayarını, lastiği, sıralama riskini ve bot taktiğini seç. Işıklar sönmeden kaydedilir.',
  checkin: 'Duvara geç: yarışı kendin süreceğini bildir. Seçimler hâlâ değiştirilebilir.',
  live: 'Yarış canlı: lastik aşınmasını izle, doğru anda pite çağır.',
  result: 'Yarış bitti. Sunucunun yazdığı sonuç ve ödeme aşağıda.',
  'season-over': 'Sezon tamamlandı. Yeni sezon lobide açılacak.',
};

const fitColour = { green: colors.electricCyan, yellow: colors.solarAmber, red: colors.neonCoral } as const;

/**
 * The race weekend, as the SERVER runs it.
 *
 * Which panel shows is decided by `displayWeekPanel(displayPhase(race))` and
 * by nothing else. This screen used to branch on `gameStore.ts`'s local
 * `weekend.phase` — eight values walked by the local engine's own session
 * functions. That engine is gone: the lobby's phase arrives on `/race/live`
 * and is the only thing that moves the weekend on. There is deliberately no
 * fallback to a local phase when the frame has not landed yet (`'loading'`)
 * or when there is no lobby at all (`'no-lobby'`) — a local weekend would be
 * a weekend the server is not running.
 */
export function RaceWeekScreen() {
  const shell = useShellLayout();
  const weekend = useGameStore((s) => s.weekend);
  const carStats = useGameStore((s) => s.carStats);
  const round = useGameStore((s) => s.round);
  const totalRounds = useGameStore((s) => s.totalRounds);
  const testing = useGameStore((s) => s.testing);

  const raceSlice = useGameStore((s) => s.race);
  const phase = displayPhase(raceSlice);
  const panel = displayWeekPanel(phase);
  // Season and round are the SERVER's while seated — the local counters no
  // longer advance at all, since nothing local settles a weekend.
  const localSeason = useGameStore((s) => s.season);
  const season = phase.kind === 'ready' ? phase.seasonNo : localSeason;
  const shownRound = phase.kind === 'ready' ? phase.roundNo : round;

  const checkinRace = useGameStore((s) => s.checkinRace);
  const lobbyId = raceSlice.lobbyId;
  const choiceOutcome = useGameStore((s) => s.race.lastWeekendChoiceOutcome);

  // The result sheet reads the server's own persisted breakdown; ask for it
  // as soon as the lobby says this round has been settled.
  const hydrateSettlement = useGameStore((s) => s.settlementApi.hydrate);
  const settled = panel === 'result' || panel === 'season-over';
  useEffect(() => {
    if (lobbyId && settled) void hydrateSettlement(lobbyId, shownRound, season);
  }, [lobbyId, settled, shownRound, season, hydrateSettlement]);

  const track = trackForRound(shownRound);
  const schedule = weekendSchedule(track);
  const inTesting = testing.day <= TEST_DAYS;
  const sessions = schedule.map((sess) => ({ ...sess, status: sessionStatus(sess.key, panel) }));
  const demand = demandPct(track);
  const nextKey = sessions.find((s) => s.status === 'upcoming')?.key;
  const forecastPct = Math.round(weekend.weather.forecast * 100);

  // Live race and result: the action goes first, the weekend overview after it.
  const liveFirst = panel === 'live' || panel === 'result';
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
                      {localClock(s.startUtcMin, new Date())}
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
        eyebrow={`Sezon ${season} · ${shownRound}/${totalRounds} yarış · ${track.circuit}`}
        icon="race-week"
        title={track.gp}
        subtitle={panelHint[panel]}
      />

      {!liveFirst && overview}

      {inTesting ? (
        <TestingPanel />
      ) : (
        <>
          {(panel === 'no-lobby' || panel === 'loading' || panel === 'season-over') && (
            <GlassCard contentStyle={{ gap: spacing.sm }}>
              <AppText variant="cardTitle" color={colors.textPrimary}>
                {weekPanelLabel[panel]}
              </AppText>
              <AppText variant="bodySmall" color={colors.textSecondary}>
                {panelHint[panel]}
              </AppText>
            </GlassCard>
          )}
          {(panel === 'choices' || panel === 'checkin') && (
            <>
              <PracticePanel />
              <QualifyingPanel />
              <BriefCard />
            </>
          )}
          {panel === 'checkin' && lobbyId && (
            <GlassCard active contentStyle={{ gap: spacing.sm }}>
              <AppText variant="cardTitle" color={colors.textPrimary}>
                Duvara geç
              </AppText>
              <AppText variant="bodySmall" color={colors.textSecondary}>
                Yarışı kendin süreceğini bildir. Bildirmezsen aracı seçtiğin taktikle yardımcı bot yönetir.
              </AppText>
              {choiceOutcome?.ok === false && (
                <AppText variant="labelSmall" color={colors.neonCoral}>
                  {weekendChoiceErrorText(choiceOutcome.error)}
                </AppText>
              )}
              <GlassButton
                label="Yarışa hazırım"
                onPress={() => {
                  haptic.medium();
                  void checkinRace(lobbyId);
                }}
              />
            </GlassCard>
          )}
          {panel === 'live' && <LiveRacePanel />}
          {panel === 'result' && <RaceResultSheet />}
        </>
      )}
      {liveFirst && overview}
      {!inTesting && panel !== 'live' && <LeagueCard />}
    </ScrollView>
  );
}

/**
 * Where one scheduled session stands, given the panel the server's phase
 * chose. The schedule strip is a rough shape of the weekend, not a state
 * machine: the server has no practice/qualifying sessions of its own, so
 * everything before the race is `completed` once the lobby is live.
 */
function sessionStatus(key: SessionKey, panel: WeekPanel): SessionStatus {
  const raceDone = panel === 'result' || panel === 'season-over';
  if (key === 'RACE' || key === 'SPRINT') {
    return raceDone ? 'completed' : panel === 'live' ? 'active' : 'upcoming';
  }
  // FP1-3 / SQ / Q: the server folds these into lights-out.
  return panel === 'live' || raceDone ? 'completed' : panel === 'checkin' ? 'active' : 'upcoming';
}
