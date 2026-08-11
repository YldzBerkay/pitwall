import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, layout, spacing } from '@/theme';
import { teamState, drivers, alerts as alertData, type Driver } from '@/data/mock';
import { useGameStore } from '@/store/gameStore';
import { AppText, GlassCard, Icon, type IconName } from '@/components/atoms';
import { CarStatCard, PilotAvatar } from '@/components/molecules';
import { NextRaceWidget, RPEconomyCard } from '@/components/organisms';
import { haptic } from '@/lib/haptics';

const alertIcon: Record<string, IconName> = {
  meeting: 'meeting',
  token: 'token',
  sponsor: 'alert',
};

function toneColor(tone: string): string {
  switch (tone) {
    case 'amber':
      return colors.solarAmber;
    case 'red':
      return colors.neonCoral;
    default:
      return colors.accentBlueLight;
  }
}

function SectionLabel({ children }: { children: string }) {
  return (
    <AppText variant="labelSmall" color={colors.textTertiary} uppercase className="mb-2 ml-1">
      {children}
    </AppText>
  );
}

export function ManagerHomeScreen() {
  const insets = useSafeAreaInsets();
  const { rp, weekEarned, carStats, upgradeStat, navCollapsed } = useGameStore();
  const navWidth = navCollapsed ? layout.navCollapsed : layout.navExpanded;

  const onUpgrade = (label: string) => {
    const ok = upgradeStat(label);
    ok ? haptic.success() : haptic.error();
  };

  return (
    <ScrollView
      className="flex-1"
      contentContainerStyle={{
        paddingTop: layout.headerHeight + insets.top + spacing.lg,
        paddingLeft: navWidth + insets.left + spacing.xl,
        paddingRight: insets.right + spacing.xl,
        paddingBottom: insets.bottom + spacing.xl,
        gap: spacing.lg,
      }}
      showsVerticalScrollIndicator={false}
    >
      {/* Row 1 — race · economy · inbox */}
      <View className="flex-row" style={{ gap: spacing.lg }}>
        <View style={{ flex: 1.4 }}>
          <SectionLabel>Next Race</SectionLabel>
          <NextRaceWidget
            gp={teamState.nextRace.gp}
            country={teamState.nextRace.country}
            circuit={teamState.nextRace.circuit}
            type={teamState.nextRace.type}
            startsInMs={teamState.nextRace.startsInMs}
          />
        </View>

        <View className="flex-1">
          <SectionLabel>Economy</SectionLabel>
          <RPEconomyCard rp={rp} weekEarned={weekEarned} />
        </View>

        <View className="flex-1">
          <SectionLabel>Inbox</SectionLabel>
          <GlassCard padded={false}>
            {alertData.map((a, i) => (
              <View
                key={a.id}
                className={`flex-row items-center gap-3 px-4 py-3 ${
                  i < alertData.length - 1 ? 'border-b border-border-default' : ''
                }`}
              >
                <Icon name={alertIcon[a.id] ?? 'alert'} size={18} color={toneColor(a.tone)} />
                <AppText
                  variant="bodySmall"
                  color={colors.textSecondary}
                  className="flex-1"
                  numberOfLines={1}
                >
                  {a.title}
                </AppText>
                <Icon name="chevron" size={16} color={colors.textTertiary} />
              </View>
            ))}
          </GlassCard>
        </View>
      </View>

      {/* Row 2 — car development · pilots */}
      <View className="flex-row" style={{ gap: spacing.lg }}>
        <View className="flex-1">
          <SectionLabel>Car Development</SectionLabel>
          <GlassCard>
            {carStats.map((stat, i) => (
              <CarStatCard
                key={stat.label}
                {...stat}
                last={i === carStats.length - 1}
                onUpgrade={() => onUpgrade(stat.label)}
              />
            ))}
          </GlassCard>
        </View>

        {drivers.map((driver) => (
          <View key={driver.number} className="flex-1">
            <SectionLabel>{`Pilot · #${driver.number}`}</SectionLabel>
            <PilotCard driver={driver} />
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function PilotCard({ driver }: { driver: Driver }) {
  const xpPct = Math.round((driver.xp / driver.xpMax) * 100);
  return (
    <GlassCard className="gap-4">
      <View className="flex-row items-center gap-3">
        <PilotAvatar driver={driver} size={46} />
        <View className="flex-1">
          <AppText variant="cardTitle" color={colors.textPrimary} numberOfLines={1}>
            {driver.name}
          </AppText>
          <AppText variant="labelSmall" color={colors.textTertiary} uppercase numberOfLines={1}>
            {driver.category} · LVL {driver.level}
          </AppText>
        </View>
      </View>

      <View className="flex-row justify-between">
        <PilotStat label="PACE" value={driver.stats.PACE} />
        <PilotStat label="RACE" value={driver.stats.RACECRAFT} />
        <PilotStat label="CONS" value={driver.stats.CONSISTENCY} />
        <PilotStat label="WET" value={driver.stats.WET} />
      </View>

      <View className="gap-1.5">
        <View className="flex-row justify-between">
          <AppText variant="labelSmall" color={colors.textTertiary} uppercase>
            XP
          </AppText>
          <AppText variant="labelSmall" color={colors.textSecondary}>
            {driver.xp} / {driver.xpMax}
          </AppText>
        </View>
        <View className="h-1.5 overflow-hidden rounded-full bg-surface2">
          <View className="h-full rounded-full bg-accent" style={{ width: `${xpPct}%` }} />
        </View>
      </View>
    </GlassCard>
  );
}

function PilotStat({ label, value }: { label: string; value: number }) {
  return (
    <View className="items-center">
      <AppText variant="stat" color={colors.textPrimary}>
        {value}
      </AppText>
      <AppText variant="labelSmall" color={colors.textTertiary} uppercase>
        {label}
      </AppText>
    </View>
  );
}
