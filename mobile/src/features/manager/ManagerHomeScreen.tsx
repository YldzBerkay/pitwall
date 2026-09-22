import { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { colors, spacing } from '@/theme';
import { teamState } from '@/data/mock';
import { overallOf, playerTeam } from '@pitwall/shared/teams';
import { useGameStore, type WeekendPhase } from '@/store/gameStore';
import { trackForRound } from '@pitwall/shared/tracks';
import { AppText, Avatar, Cols, GlassCard, Icon, ScreenHeader, type IconName } from '@/components/atoms';
import { CarStatCard } from '@/components/molecules';
import { CarTurntable, NextRaceWidget, RPEconomyCard } from '@/components/organisms';
import { describeSpec, formatDuration } from '@pitwall/shared/carCustomisation';
import { brandByKey } from '@pitwall/shared/sponsors';
import { explainPace } from '@pitwall/shared/raceEngine';
import { haptic } from '@/lib/haptics';
import { useShellLayout } from '@/lib/useShellLayout';

/** Height of the 3D car panel: generous but bounded so a landscape phone keeps room below it. */
const CAR_VIEW_HEIGHT = 200;

const phaseLabel: Record<WeekendPhase, string> = {
  practice: 'Antrenman günü',
  sprintQualifying: 'Sprint sıralaması',
  sprintGrid: 'Sprint gridi hazır',
  sprint: 'Sprint canlı',
  qualifying: 'Sıralama',
  grid: 'Grid hazır',
  race: 'Yarış canlı',
  result: 'Önceki yarış bitti',
};

interface Todo {
  icon: IconName;
  title: string;
  detail: string;
  route: string;
  urgent?: boolean;
}

/**
 * Home: the car, the next race, the money, and a short list of what needs the
 * manager's attention today. Every card says what it is for in one line so a
 * new player never has to guess what a number means.
 */
export function ManagerHomeScreen() {
  const shell = useShellLayout();
  const router = useRouter();
  const rp = useGameStore((s) => s.rp);
  const weekEarned = useGameStore((s) => s.weekEarned);
  const carStats = useGameStore((s) => s.carStats);
  const build = useGameStore((s) => s.build);
  const buildTimeFor = useGameStore((s) => s.buildTimeFor);
  const buildCostFor = useGameStore((s) => s.buildCostFor);
  const startUpgrade = useGameStore((s) => s.startUpgrade);
  const collectUpgrade = useGameStore((s) => s.collectUpgrade);
  const livery = useGameStore((s) => s.livery);
  const compound = useGameStore((s) => s.compound);
  const rim = useGameStore((s) => s.rim);
  const sponsorships = useGameStore((s) => s.sponsorships);
  const championshipPosition = useGameStore((s) => s.championshipPosition);
  const round = useGameStore((s) => s.round);
  const totalRounds = useGameStore((s) => s.totalRounds);
  const season = useGameStore((s) => s.season);
  const weekend = useGameStore((s) => s.weekend);
  const drivers = useGameStore((s) => s.drivers);
  const injuries = useGameStore((s) => s.injuries);
  const training = useGameStore((s) => s.training);
  const staff = useGameStore((s) => s.staff);
  const missions = useGameStore((s) => s.missions);
  const nextMissionAt = useGameStore((s) => s.nextMissionAt);
  const setupFn = useGameStore((s) => s.setup);
  const track = trackForRound(round);
  const [carWidth, setCarWidth] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  // Refresh the build countdown once a minute; the clock lives in state so render stays pure.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const buildDone = !!build && now >= build.endsAt;

  const stat = (label: string) => carStats.find((s) => s.label === label)?.value ?? 50;
  const spec = describeSpec(stat('MOTOR'), stat('AERO'), stat('GRIP'));

  const onUpgrade = (label: string) => {
    if (startUpgrade(label) === 'ok') {
      haptic.success();
    } else {
      haptic.error();
    }
  };

  const onCollect = () => {
    if (collectUpgrade()) {
      haptic.success();
    } else {
      haptic.error();
    }
  };

  // What deserves attention right now, derived from state — not a mock inbox.
  const todos: Todo[] = [];
  if (weekend.phase === 'practice') {
    todos.push({ icon: 'race-week', title: `Antrenman seansı ${weekend.practiceSessions.length}/${weekend.practiceCount} yapıldı`, detail: 'Araç ayarını seç, antrenmanları yap, sıralamaya geç.', route: '/(tabs)/race-week', urgent: true });
  } else if (weekend.phase === 'race' || weekend.phase === 'sprint') {
    todos.push({ icon: 'live', title: 'Yarış canlı', detail: 'Pit duvarına dön; çağrılar bir sonraki turda uygulanır.', route: '/(tabs)/race-week', urgent: true });
  } else if (weekend.phase === 'result') {
    todos.push({ icon: 'check', title: 'Sonuçlar hazır', detail: 'Ödemeyi gör ve sonraki hafta sonuna geç.', route: '/(tabs)/race-week', urgent: true });
  } else {
    todos.push({ icon: 'race-week', title: phaseLabel[weekend.phase], detail: 'Hafta sonu bekliyor; kararını ver ve devam et.', route: '/(tabs)/race-week', urgent: true });
  }
  if (!training) todos.push({ icon: 'driver', title: 'Sürücü antrenmanı planlanmadı', detail: '6 saatlik bir antrenman başlat; genç sürücüler hızlı gelişir.', route: '/(tabs)/paddock' });
  const emptySeats = (['mechanic', 'strategist', 'pitCrew'] as const).filter((r) => !staff[r]).length;
  if (emptySeats > 0) todos.push({ icon: 'mechanic', title: `${emptySeats} personel kadrosu boş`, detail: 'Mekanik, stratejist ve pit şefi yarış sonucunu doğrudan etkiler.', route: '/(tabs)/paddock' });
  if (!missions.some((m) => !m.outcome) && now >= nextMissionAt()) todos.push({ icon: 'spy', title: 'Ajan gönderilebilir', detail: 'Bir rakibin güçlü olduğu alanı hedefle; başarı sonraki yükseltmeni ×1,5 yapar.', route: '/(tabs)/paddock' });
  if (build && buildDone) {
    todos.push({ icon: 'development', title: 'Yeni parça hazır', detail: 'Fabrikadaki parçayı araca tak; değer şimdi yükselir.', route: '/(tabs)/development', urgent: true });
  } else if (build) {
    todos.push({ icon: 'development', title: `Fabrika üretimde · ${formatDuration(build.endsAt - now)} kaldı`, detail: 'Tek tezgâh var; bu parça bitene kadar yeni yükseltme başlatılamaz.', route: '/(tabs)/development' });
  } else {
    const affordable = carStats.filter((s) => rp >= buildCostFor(s.label)).length;
    if (affordable > 0) todos.push({ icon: 'development', title: `RP'n ${affordable} yükseltmeye yetiyor`, detail: 'İlk yükseltme 6 saat sürer, aynı değerin sonraki her yükseltmesi 1,5 kat uzun.', route: '/(tabs)/development' });
  }

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
        eyebrow={`Sezon ${season} · ${round}/${totalRounds} yarış · ${championshipPosition}. sıra`}
        icon="manager"
        title="Garaj"
        subtitle="Takımının bugünkü durumu ve seni bekleyen kararlar."
      />

      <Cols weights={[1.2, 1]}>
        <View style={{ flex: 1 }}>
          <NextRaceWidget
            track={track}
            round={round}
            totalRounds={totalRounds}
            startsInMs={teamState.raceStartsInMs}
            phaseLabel={phaseLabel[weekend.phase]}
            onPress={() => {
              haptic.select();
              router.push('/(tabs)/race-week');
            }}
          />
        </View>

        <GlassCard className="flex-1" padded={false}>
          <View className="flex-row items-center justify-between px-4 pt-3">
            <View>
              <AppText variant="cardTitle" color={colors.textPrimary}>
                Bugün yapılacaklar
              </AppText>
              <AppText variant="labelSmall" color={colors.textTertiary}>
                Öncelik sırasına göre
              </AppText>
            </View>
            <View className="rounded-full px-2 py-0.5" style={{ backgroundColor: colors.accentSoft }}>
              <AppText variant="labelSmall" color={colors.accentLime} style={{ fontFamily: 'JetBrainsMono_700Bold' }}>
                {todos.length}
              </AppText>
            </View>
          </View>
          <View className="px-2 pb-2 pt-1">
            {todos.map((t, i) => (
              <Pressable
                key={t.title}
                onPress={() => {
                  haptic.select();
                  router.push(t.route as never);
                }}
                className="flex-row items-center gap-3 rounded-md px-2 py-2.5"
                style={({ pressed }) => ({ backgroundColor: pressed ? 'rgba(255,255,255,0.04)' : 'transparent', borderTopWidth: i === 0 ? 0 : 1, borderTopColor: colors.borderDefault })}
              >
                <View className="h-9 w-9 items-center justify-center rounded-md" style={{ backgroundColor: t.urgent ? colors.accentSoft : 'rgba(255,255,255,0.05)' }}>
                  <Icon name={t.icon} size={18} color={t.urgent ? colors.accentLime : colors.textSecondary} />
                </View>
                <View className="flex-1">
                  <AppText variant="label" color={colors.textPrimary} numberOfLines={1}>
                    {t.title}
                  </AppText>
                  <AppText variant="labelSmall" color={colors.textTertiary} numberOfLines={2}>
                    {t.detail}
                  </AppText>
                </View>
                <Icon name="chevron" size={18} color={colors.textTertiary} />
              </Pressable>
            ))}
          </View>
        </GlassCard>
      </Cols>

      <Cols weights={[1.3, 1]}>
        <View style={{ flex: 1 }}>
          <View className="overflow-hidden rounded-xl border border-border-default" style={{ backgroundColor: '#050506' }} onLayout={(e) => setCarWidth(e.nativeEvent.layout.width)}>
            {carWidth > 0 && (
              <CarTurntable width={carWidth} height={CAR_VIEW_HEIGHT} spec={spec.spec} livery={livery} compound={compound} rim={rim} sponsorships={sponsorships} />
            )}
            <View className="absolute left-3 top-3 flex-row items-center gap-2">
              <View className="rounded-sm border border-border-active bg-accent-soft px-2 py-1">
                <AppText variant="labelSmall" color={colors.accentLime} uppercase>
                  Kademe {spec.spec}
                </AppText>
              </View>
              <AppText variant="labelSmall" color={colors.textSecondary}>
                Takım aracı · sürükleyerek döndür
              </AppText>
            </View>
            <View className="absolute right-3 top-3 flex-row items-center gap-1.5">
              {sponsorships.map((deal) => {
                const brand = brandByKey(deal.brandKey);
                if (!brand) return null;
                return (
                  <View key={deal.slot} className="rounded-sm px-1.5 py-0.5" style={{ backgroundColor: brand.color }}>
                    <AppText variant="labelSmall" color={colors.onAccent} style={{ fontSize: 9 }}>
                      {brand.short}
                    </AppText>
                  </View>
                );
              })}
            </View>
          </View>
        </View>

        <GlassCard className="flex-1" contentStyle={{ gap: 4 }}>
          <View className="flex-row items-center justify-between">
            <View>
              <AppText variant="cardTitle" color={colors.textPrimary}>
                Araç geliştirme
              </AppText>
              <AppText variant="labelSmall" color={colors.textTertiary}>
                Işık: bu değer sıradaki piste ne kadar uyuyor
              </AppText>
            </View>
            <Pressable onPress={() => router.push('/(tabs)/development')} className="flex-row items-center gap-1">
              <AppText variant="labelSmall" color={colors.accentLime}>
                Fabrika
              </AppText>
              <Icon name="chevron" size={14} color={colors.accentLime} />
            </Pressable>
          </View>
          {carStats.map((s, i) => (
            <CarStatCard
              key={s.label}
              {...s}
              cost={buildCostFor(s.label)}
              last={i === carStats.length - 1}
              building={build?.label === s.label}
              done={buildDone && build?.label === s.label}
              busy={!!build && build.label !== s.label}
              timeLabel={
                build?.label === s.label
                  ? formatDuration(build.endsAt - now)
                  : formatDuration(buildTimeFor(s.label))
              }
              onUpgrade={() => onUpgrade(s.label)}
              onCollect={onCollect}
            />
          ))}
        </GlassCard>
      </Cols>

      <Cols>
        <View className="flex-1">
          <RPEconomyCard rp={rp} weekEarned={weekEarned} />
        </View>
        {drivers.map((d, i) => {
          const idx = i as 0 | 1;
          const pace = explainPace(setupFn(), d, track);
          const hurt = injuries[idx] > 0;
          return (
            <GlassCard key={d.number} className="flex-1" contentStyle={{ gap: 10 }}>
              <View className="flex-row items-center gap-3">
                <Avatar name={d.name} colour={playerTeam.colour} number={d.number} size={44} />
                <View className="flex-1">
                  <AppText variant="cardTitle" color={colors.textPrimary} numberOfLines={1}>
                    {d.name}
                  </AppText>
                  <AppText variant="labelSmall" color={hurt ? colors.neonCoral : colors.textTertiary} numberOfLines={1}>
                    {hurt ? `Sakat · ${injuries[idx]} yarış dışında` : `${d.age} yaş · ${i === 0 ? 'Birinci' : 'İkinci'} sürücü`}
                  </AppText>
                </View>
                <View className="items-end">
                  <AppText variant="stat" color={colors.accentLime} style={{ fontSize: 22, lineHeight: 26 }}>
                    {overallOf(d.stats)}
                  </AppText>
                  <AppText variant="labelSmall" color={colors.textTertiary}>
                    potansiyel {d.potential}
                  </AppText>
                </View>
              </View>
              <View className="flex-row flex-wrap justify-between" style={{ rowGap: 6 }}>
                <MiniStat label="Hız" value={d.stats.pace} />
                <MiniStat label="Geçiş" value={d.stats.racecraft} />
                <MiniStat label="İstikrar" value={d.stats.consistency} />
                <MiniStat label="Yağmur" value={d.stats.wet} />
                <MiniStat label="Kalkış" value={d.stats.reaction} />
              </View>
              <AppText variant="labelSmall" color={colors.textTertiary}>
                Bu pistte hız payı: araç {String(pace.carShare).replace('.', ',')} + sürücü {String(pace.driverShare).replace('.', ',')}. Sürücünün 1 hız puanı yaklaşık {String(pace.secPerDriverPoint).replace('.', ',')} sn/tur.
              </AppText>
            </GlassCard>
          );
        })}
      </Cols>
    </ScrollView>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <View className="flex-1 items-center">
      <AppText variant="statSmall" color={colors.textPrimary}>
        {Math.round(value)}
      </AppText>
      <AppText variant="labelSmall" color={colors.textTertiary} style={{ fontSize: 10, lineHeight: 12 }}>
        {label}
      </AppText>
    </View>
  );
}
