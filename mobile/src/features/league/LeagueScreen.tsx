import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, spacing } from '@/theme';
import { AppText, Avatar, Cols, GlassCard, ScreenHeader, SegmentTabs } from '@/components/atoms';
import { POINTS_FOR_PLACE, playerTeam, teamByKey, teams } from '@/data/teams';
import { trackForRound } from '@/data/tracks';
import { useGameStore } from '@/store/gameStore';
import { useShellLayout } from '@/lib/useShellLayout';
import { Pos, fmtGap } from '@/features/raceweek/shared';

type Tab = 'teams' | 'drivers';

/**
 * The championship: constructors' table, a drivers' view derived from the
 * last results, and the last race classification. The header explains what
 * the points are worth so the table is never just numbers.
 */
export function LeagueScreen() {
  const shell = useShellLayout();
  const standings = useGameStore((s) => s.standings);
  const lastResult = useGameStore((s) => s.lastResult);
  const lastSettlement = useGameStore((s) => s.lastSettlement);
  const round = useGameStore((s) => s.round);
  const totalRounds = useGameStore((s) => s.totalRounds);
  const season = useGameStore((s) => s.season);
  const rosters = useGameStore((s) => s.rosters);
  const career = useGameStore((s) => s.career);
  const [tab, setTab] = useState<Tab>('teams');

  const leaderPoints = standings[0]?.points ?? 0;
  const mine = standings.find((s) => s.teamKey === playerTeam.key);
  const gapToLeader = mine ? leaderPoints - mine.points : 0;
  const racesLeft = totalRounds - (round - 1);

  // Drivers' view: the last race's points per driver, since the season table is by team.
  const driverRows = lastResult
    ? lastResult.order
        .filter((e) => !e.dnf)
        .map((e) => ({ ...e, pts: POINTS_FOR_PLACE[e.position - 1] ?? 0 }))
    : [];

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
        eyebrow={`Sezon ${season} · ${round - 1}/${totalRounds} yarış tamamlandı`}
        icon="league"
        title="Lig"
        subtitle="Sıran sponsor gelirini ve sezon ödülünü belirler. Galibiyet 25 puan, 10. sıra 1 puan."
        right={<SegmentTabs<Tab> items={[{ key: 'teams', label: 'Takımlar' }, { key: 'drivers', label: 'Sürücüler' }]} value={tab} onChange={setTab} />}
      />

      {/* Position banner */}
      <View className="overflow-hidden rounded-xl" style={{ borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' }}>
        <LinearGradient colors={['#2A3A12', '#171B12', '#111214']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ position: 'absolute', inset: 0 }} />
        <View className="flex-row items-center p-4" style={{ gap: 16 }}>
          <View>
            <AppText variant="labelSmall" color={colors.textSecondary}>
              Takımının sırası
            </AppText>
            <AppText variant="hero" color={colors.accentLime} style={{ fontSize: 52, lineHeight: 54 }}>
              {mine?.position ?? '—'}.
            </AppText>
          </View>
          <View className="flex-1">
            <AppText variant="label" color={colors.textPrimary}>
              {mine?.points ?? 0} puan · liderle {gapToLeader} puan fark
            </AppText>
            <AppText variant="labelSmall" color={colors.textSecondary}>
              {racesLeft} yarış kaldı · kariyer: {career.wins} galibiyet, {career.podiums} podyum.
            </AppText>
          </View>
        </View>
      </View>

      <Cols>
        {tab === 'teams' ? (
          <GlassCard className="flex-1" padded={false}>
            <View className="px-4 pt-3 pb-1">
              <AppText variant="cardTitle" color={colors.textPrimary}>
                Takımlar tablosu
              </AppText>
              <AppText variant="labelSmall" color={colors.textTertiary}>
                Sıra, sürücüler ve toplam puan
              </AppText>
            </View>
            {standings.map((s, i) => {
              const team = teamByKey(s.teamKey);
              const pct = leaderPoints ? (s.points / leaderPoints) * 100 : 0;
              const pair = rosters[team.key] ?? team.drivers;
              return (
                <View key={s.teamKey} className="flex-row items-center gap-3 px-4 py-2.5" style={{ borderTopWidth: i === 0 ? 0 : 1, borderTopColor: colors.borderDefault, backgroundColor: team.isPlayer ? colors.accentSoft : 'transparent' }}>
                  <Pos n={s.position} lit={Boolean(team.isPlayer)} width={22} />
                  <View className="h-9 w-9 items-center justify-center rounded-lg" style={{ backgroundColor: `${team.colour}22`, borderWidth: 1.5, borderColor: `${team.colour}AA` }}>
                    <AppText variant="labelSmall" color={colors.textPrimary} style={{ fontFamily: 'JetBrainsMono_700Bold', fontSize: 11 }}>
                      {team.short}
                    </AppText>
                  </View>
                  <View className="flex-1">
                    <AppText variant="label" color={team.isPlayer ? colors.accentLime : colors.textPrimary} numberOfLines={1}>
                      {team.name}
                    </AppText>
                    <AppText variant="labelSmall" color={colors.textTertiary} numberOfLines={1}>
                      {pair.map((d) => `${d.name} ${Math.round(d.skill)}`).join(' · ')}
                    </AppText>
                    <View className="mt-1.5 h-1 overflow-hidden rounded-full" style={{ backgroundColor: 'rgba(255,255,255,0.06)' }}>
                      <View className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: team.isPlayer ? colors.accentLime : 'rgba(255,255,255,0.28)' }} />
                    </View>
                  </View>
                  <View className="items-end">
                    <AppText variant="stat" color={team.isPlayer ? colors.accentLime : colors.textPrimary} style={{ fontSize: 20, lineHeight: 24 }}>
                      {s.points}
                    </AppText>
                    <AppText variant="labelSmall" color={colors.textTertiary} style={{ fontSize: 10, lineHeight: 12 }}>
                      puan
                    </AppText>
                  </View>
                </View>
              );
            })}
          </GlassCard>
        ) : (
          <GlassCard className="flex-1" padded={false}>
            <View className="px-4 pt-3 pb-1">
              <AppText variant="cardTitle" color={colors.textPrimary}>
                Sürücüler · son yarış
              </AppText>
              <AppText variant="labelSmall" color={colors.textTertiary}>
                Son yarışın puan dağılımı; sürücü şampiyonası tablosu sezon boyunca buradan birikir
              </AppText>
            </View>
            {driverRows.length === 0 && (
              <AppText variant="bodySmall" color={colors.textTertiary} className="px-4 pb-4">
                Henüz yarış koşulmadı.
              </AppText>
            )}
            {driverRows.map((e, i) => {
              const team = teamByKey(e.teamKey);
              return (
                <View key={`${e.teamKey}-${e.driverIdx}`} className="flex-row items-center gap-3 px-4 py-2" style={{ borderTopWidth: i === 0 ? 0 : 1, borderTopColor: colors.borderDefault }}>
                  <Pos n={e.position} lit={Boolean(team.isPlayer)} width={22} />
                  <Avatar name={e.driver} colour={team.colour} size={34} />
                  <View className="flex-1">
                    <AppText variant="label" color={team.isPlayer ? colors.accentLime : colors.textPrimary} numberOfLines={1}>
                      {e.driver}
                    </AppText>
                    <AppText variant="labelSmall" color={colors.textTertiary} numberOfLines={1}>
                      {team.name}
                    </AppText>
                  </View>
                  <View className="items-end">
                    <AppText variant="stat" color={colors.textPrimary} style={{ fontSize: 20, lineHeight: 24 }}>
                      {e.pts}
                    </AppText>
                    <AppText variant="labelSmall" color={colors.textTertiary} style={{ fontSize: 10, lineHeight: 12 }}>
                      puan
                    </AppText>
                  </View>
                </View>
              );
            })}
          </GlassCard>
        )}

        <GlassCard className="flex-1" padded={false}>
          <View className="flex-row items-center justify-between px-4 pt-3 pb-1">
            <View>
              <AppText variant="cardTitle" color={colors.textPrimary}>
                Son yarış
              </AppText>
              <AppText variant="labelSmall" color={colors.textTertiary}>
                {lastSettlement ? `${trackForRound(lastSettlement.round).gp} · lidere fark saniye` : 'Bitiş sırası ve lidere farklar'}
              </AppText>
            </View>
          </View>
          {!lastResult && (
            <AppText variant="bodySmall" color={colors.textTertiary} className="px-4 pb-4">
              Bu sezon henüz yarış koşulmadı. Yarış sekmesinden hafta sonunu başlat.
            </AppText>
          )}
          {lastResult?.order.map((e, i) => {
            const team = teamByKey(e.teamKey);
            return (
              <View key={`${e.teamKey}-${e.driverIdx}`} className="flex-row items-center gap-3 px-4 py-1.5" style={{ opacity: e.dnf ? 0.5 : 1, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: colors.borderDefault }}>
                <Pos n={e.position} lit={e.teamKey === playerTeam.key} width={22} />
                <View className="h-4 w-1 rounded-full" style={{ backgroundColor: team.colour }} />
                <AppText variant="labelSmall" color={e.teamKey === playerTeam.key ? colors.accentLime : colors.textPrimary} numberOfLines={1} style={{ flex: 1 }}>
                  {e.driver}
                </AppText>
                <AppText variant="labelSmall" color={colors.textTertiary} style={{ fontFamily: 'JetBrainsMono_700Bold', fontSize: 10 }}>
                  {team.short}
                </AppText>
                <AppText variant="labelSmall" color={e.dnf ? colors.neonCoral : colors.textSecondary} style={{ fontFamily: 'JetBrainsMono_700Bold', width: 56, textAlign: 'right' }}>
                  {fmtGap(e.gapSec)}
                </AppText>
              </View>
            );
          })}
        </GlassCard>
      </Cols>

      <AppText variant="labelSmall" color={colors.textTertiary}>
        {teams.length} takım · sezon sonunda tablo sıfırlanır; araç, para ve kadro taşınır.
      </AppText>
    </ScrollView>
  );
}
