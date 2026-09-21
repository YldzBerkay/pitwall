import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { colors, spacing } from '@/theme';
import { AppText, GlassButton, GlassCard, Icon, RankIcon, Cols, ScreenHeader } from '@/components/atoms';
import { haptic } from '@/lib/haptics';
import { playerTeam } from '@/data/teams';
import {
  achievementDefs,
  nextRank,
  rankFor,
  rankProgress,
  ranks,
  underdogMultiplier,
} from '@/data/achievements';
import { strengthRank } from '@/data/raceEngine';
import { useGameStore } from '@/store/gameStore';
import { useShellLayout } from '@/lib/useShellLayout';

/** Team identity, rank, and the achievement ledger. */
export function ProfileScreen() {
  const shell = useShellLayout();
  const career = useGameStore((s) => s.career);
  const authUser = useGameStore((s) => s.auth.user);

  const [showAll, setShowAll] = useState(false);
  const rank = rankFor(career.score);
  const next = nextRank(career.score);
  const progress = rankProgress(career.score);
  const gridRank = strengthRank(playerTeam.key);
  const multiplier = underdogMultiplier(playerTeam.key);

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
        eyebrow={`Rütbe ${rank.level}/10 · ${career.score} kariyer puanı`}
        icon="profile"
        title="Profil"
        subtitle="Başarımlar kariyer skoru verir, skor rütbeni belirler. Zayıf takımla kazanmak daha çok sayılır."
        right={
          <GlassButton
            label="Ayarlar"
            variant="ghost"
            onPress={() => {
              haptic.select();
              router.push('/settings');
            }}
          />
        }
      />

      <GlassCard contentStyle={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md }}>
        <View style={{ flex: 1 }}>
          <AppText variant="cardTitle" color={colors.textPrimary}>
            {authUser ? authUser.nickname : 'Hesap'}
          </AppText>
          <AppText variant="bodySmall" color={colors.textSecondary}>
            {authUser
              ? `${authUser.region ?? 'Bölge seçilmedi'} · ${authUser.rankPoints} rütbe puanı · ${authUser.gold} Altın`
              : 'Giriş yapılmadı — takma ad, bölge ve rütbe puanın cihazlar arası taşınmaz.'}
          </AppText>
        </View>
        <GlassButton
          label={authUser ? 'Hesap' : 'Giriş yap'}
          variant="secondary"
          onPress={() => {
            haptic.select();
            router.push('/auth');
          }}
        />
      </GlassCard>

      <Cols align="flex-start">
        {/* Rank */}
        <GlassCard className="flex-1" contentStyle={{ gap: spacing.md }}>
          <View className="flex-row items-center gap-3">
            <View
              className="h-14 w-14 items-center justify-center rounded-lg"
              style={{ backgroundColor: `${rank.colour}22`, borderWidth: 1.5, borderColor: rank.colour }}
            >
              <RankIcon level={rank.level} colour={rank.colour} size={36} />
            </View>
            <View className="flex-1">
              <AppText variant="labelSmall" color={colors.textTertiary} uppercase>
                Mevcut rütbe
              </AppText>
              <AppText variant="sectionTitle" color={colors.textPrimary}>
                {rank.name}
              </AppText>
              <AppText variant="labelSmall" color={colors.textSecondary}>
                Rütbe {rank.level}/10 · {career.score} kariyer puanı
              </AppText>
            </View>
          </View>
          <View>
            <View className="mb-1.5 flex-row justify-between">
              <AppText variant="labelSmall" color={colors.textTertiary} uppercase>
                {next ? `Sonraki rütbe · ${next.name}` : 'En üst rütbe'}
              </AppText>
              {next && (
                <AppText variant="labelSmall" color={colors.textSecondary} style={{ fontFamily: 'JetBrainsMono_700Bold' }}>
                  {career.score}/{next.threshold}
                </AppText>
              )}
            </View>
            <View className="h-2 overflow-hidden rounded-full" style={{ backgroundColor: 'rgba(255,255,255,0.06)' }}>
              <View className="h-full rounded-full" style={{ width: `${Math.round(progress * 100)}%`, backgroundColor: rank.colour }} />
            </View>
          </View>
          <AppText variant="bodySmall" color={colors.textSecondary}>
            Takım güç sırası {gridRank}: kazandığın puanlar ×{multiplier.toFixed(1).replace('.', ',')} sayılır.
          </AppText>
          <Pressable onPress={() => setShowAll((v) => !v)} className="flex-row items-center gap-1 self-start">
            <AppText variant="labelSmall" color={colors.accentLime}>
              {showAll ? 'Rütbeleri gizle' : 'Tüm rütbeler'}
            </AppText>
            <Icon name={showAll ? 'chevron-left' : 'chevron'} size={14} color={colors.accentLime} />
          </Pressable>
          <View className="flex-row flex-wrap gap-1.5">
            {ranks.filter((r) => showAll).map((r) => (
              <View
                key={r.level}
                className="flex-row items-center gap-1 rounded-sm border px-1.5 py-0.5"
                style={{
                  borderColor: r.level <= rank.level ? r.colour : colors.borderDefault,
                  opacity: r.level <= rank.level ? 1 : 0.5,
                }}
              >
                <RankIcon level={r.level} colour={r.level <= rank.level ? r.colour : colors.textTertiary} size={14} />
                <AppText variant="labelSmall" color={r.level <= rank.level ? r.colour : colors.textTertiary} style={{ fontSize: 10, lineHeight: 12 }}>
                  {r.name}
                </AppText>
              </View>
            ))}
          </View>
        </GlassCard>

        {/* Career numbers */}
        <GlassCard className="flex-1" contentStyle={{ gap: spacing.sm }}>
          <AppText variant="cardTitle" color={colors.textPrimary}>
            Kariyer
          </AppText>
          <View className="flex-row flex-wrap">
            <Stat label="Yarış" value={career.races} />
            <Stat label="Galibiyet" value={career.wins} />
            <Stat label="Podyum" value={career.podiums} />
            <Stat label="Pole" value={career.poles} />
            <Stat label="En hızlı tur" value={career.fastestLaps} />
            <Stat label="Yarış dışı" value={career.dnfs} />
            <Stat label="Sezon" value={career.seasonsCompleted} />
            <Stat label="En iyi sezon sırası" value={career.bestChampionship ? `${career.bestChampionship}.` : 'Henüz yok'} />
          </View>
        </GlassCard>
      </Cols>

      {/* Achievement ledger */}
      <GlassCard contentStyle={{ gap: spacing.xs }}>
        <AppText variant="cardTitle" color={colors.textPrimary} className="mb-1">
          Başarımlar
        </AppText>
        <View className="flex-row flex-wrap" style={{ rowGap: spacing.sm }}>
          {achievementDefs.map((def) => {
            const n = career.counts[def.key];
            const lit = n > 0;
            return (
              <View key={def.key} className={`${shell.isWide ? 'w-1/4' : 'w-1/2'} flex-row items-center gap-2.5 pr-3`}>
                <View
                  className="h-10 w-10 items-center justify-center rounded-md"
                  style={{
                    borderWidth: 1.5,
                    borderColor: lit ? colors.accentLime : colors.borderDefault,
                    backgroundColor: lit ? colors.accentSoft : 'transparent',
                  }}
                >
                  <AppText variant="statSmall" color={lit ? colors.accentLime : colors.textTertiary}>
                    {def.glyph}
                  </AppText>
                </View>
                <View className="flex-1">
                  <View className="flex-row items-center justify-between">
                    <AppText variant="labelSmall" color={lit ? colors.textPrimary : colors.textSecondary}>
                      {def.label}
                    </AppText>
                    <AppText variant="labelSmall" color={lit ? colors.accentLime : colors.textTertiary} style={{ fontFamily: 'JetBrainsMono_700Bold' }}>
                      ×{n}
                    </AppText>
                  </View>
                  <AppText variant="labelSmall" color={colors.textTertiary} numberOfLines={2} style={{ fontSize: 10, lineHeight: 13 }}>
                    {def.description} · {def.base} puan
                  </AppText>
                </View>
              </View>
            );
          })}
        </View>
      </GlassCard>
    </ScrollView>
  );
}

function Stat({ label, value, tint = colors.textPrimary }: { label: string; value: number | string; tint?: string }) {
  return (
    <View className="w-1/2 py-1.5">
      <AppText variant="stat" color={tint}>
        {value}
      </AppText>
      <AppText variant="labelSmall" color={colors.textTertiary} uppercase>
        {label}
      </AppText>
    </View>
  );
}
