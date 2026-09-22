import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { colors, spacing } from '@/theme';
import { semanticColors } from '@/theme/colors';
import { AppText, GlassButton, GlassCard, NeonStatChip, RankIcon, Cols } from '@/components/atoms';
import { playerTeam, teamByKey } from '@pitwall/shared/teams';
import { achievementByKey, rankFor } from '@pitwall/shared/achievements';
import { brandByKey } from '@pitwall/shared/sponsors';
import { useGameStore } from '@/store/gameStore';
import { useShellLayout } from '@/lib/useShellLayout';
import { haptic } from '@/lib/haptics';
import { DriverCell, Pos, fmtGap } from './shared';

/**
 * The weekend's receipt: classification, what it paid, what it earned on the
 * profile, and where the table stands. Closing it opens the next round.
 */
export function RaceResultSheet() {
  const shell = useShellLayout();
  const weekend = useGameStore((s) => s.weekend);
  const standings = useGameStore((s) => s.standings);
  const career = useGameStore((s) => s.career);
  const nextWeekend = useGameStore((s) => s.nextWeekend);
  const seasonSummary = useGameStore((s) => s.seasonSummary);
  const dismissSeasonSummary = useGameStore((s) => s.dismissSeasonSummary);
  const colorblindMode = useGameStore((s) => s.colorblindMode);
  const semantic = semanticColors(colorblindMode);
  const [fullTable, setFullTable] = useState(false);

  const result = weekend.result;
  const settlement = weekend.settlement;
  if (!result || !settlement) return null;

  // Narrow screens: the podium zone plus our cars, unless expanded.
  const shownOrder = shell.isWide || fullTable ? result.order : result.order.filter((e) => e.position <= 6 || e.teamKey === playerTeam.key);
  const half = shell.isWide ? Math.ceil(shownOrder.length / 2) : shownOrder.length;
  const columns = shell.isWide ? [shownOrder.slice(0, half), shownOrder.slice(half)] : [shownOrder];
  const ours = result.order.filter((e) => e.teamKey === playerTeam.key);
  const a = settlement.achievements;
  const rank = rankFor(career.score);
  const playerRow = standings.find((s) => s.teamKey === playerTeam.key);

  return (
    <View style={{ gap: spacing.lg }}>

      <Cols>
          <GlassCard active className="flex-1" contentStyle={{ gap: spacing.sm }}>
            <AppText variant="cardTitle" color={colors.textPrimary}>
              Kazanç
            </AppText>
            <AppText variant="bodySmall" color={colors.textSecondary}>
              {ours.map((e) => `${e.driver.split(' ').pop()} ${e.dnf ? 'yarış dışı' : `${e.position}.`}`).join(' · ')}
            </AppText>
            <View className="flex-row items-baseline gap-2">
              <AppText variant="statLarge" color={colors.accentLime}>
                +{settlement.income}
              </AppText>
              <AppText variant="label" color={colors.textSecondary}>
                RP
              </AppText>
            </View>
            <AppText variant="bodySmall" color={colors.textSecondary}>
              {settlement.prize} yarış ödülü · sponsor ücretleri koşulsuz ödendi
              {settlement.briefFollowed ? ` · brifing ${settlement.briefFollowed}/5 tuttu: +${settlement.briefRp} RP` : ' · brifingden öneri tutmadı'}
              {settlement.bonusesEarned.length
                ? ` · hedef bonusu: ${settlement.bonusesEarned.map((k) => brandByKey(k)?.short).filter(Boolean).join(', ')}`
                : ''}
              {settlement.streaksBroken.length
                ? ` · seri bozuldu: ${settlement.streaksBroken.map((k) => brandByKey(k)?.short).filter(Boolean).join(', ')}`
                : ''}
              {settlement.expired.length ? ` · ${settlement.expired.length} sözleşme bitti` : ''}
            </AppText>
          </GlassCard>

          <GlassCard className="flex-1" contentStyle={{ gap: spacing.sm }}>
            <View className="flex-row items-center justify-between">
              <AppText variant="cardTitle" color={colors.textPrimary}>
                Başarımlar
              </AppText>
              <View className="flex-row items-center gap-1.5">
                <RankIcon level={rank.level} colour={rank.colour} size={14} />
                <AppText variant="labelSmall" color={a.score < 0 ? semantic.danger : semantic.record}>
                  {a.score >= 0 ? '+' : ''}{a.score} kariyer puanı (×{a.multiplier.toFixed(1).replace('.', ',')})
                </AppText>
              </View>
            </View>
            <View className="rounded-md border px-2.5 py-1.5" style={{ borderColor: a.targets.verdict === 'position' ? semantic.positive : a.targets.verdict === 'collapsed' ? semantic.danger : semantic.attention }}>
              <AppText variant="labelSmall" color={colors.textSecondary}>
                Hedef: {a.targets.targets.position}. sıra ve {a.targets.targets.points} puan · Sonuç: {a.targets.finish === 22 && result.playerFinish === 0 ? 'yarış dışı' : `${a.targets.finish}. sıra`}, {a.targets.pointsScored} puan
              </AppText>
              <AppText variant="labelSmall" color={a.targets.verdict === 'position' ? semantic.positive : a.targets.verdict === 'collapsed' ? semantic.danger : semantic.attention}>
                {a.targets.verdict === 'position'
                  ? `Sıralama hedefi tuttu: rütbe puanı tam (${a.rawScore})`
                  : a.targets.verdict === 'pointsOnly'
                    ? `Puan hedefi tuttu ama sıralama kaçtı: rütbe puanı kazanılmadı (${a.rawScore} yandı)`
                    : a.targets.verdict === 'missed'
                      ? 'İki hedef de kaçtı: rütbe puanı kazanılmadı'
                      : `Çöküş: hedefin ${a.targets.finish - a.targets.targets.position} sıra gerisinde, ${a.targets.penalty} rütbe puanı`}
              </AppText>
            </View>
            {a.earned.length === 0 ? (
              <AppText variant="bodySmall" color={colors.textTertiary}>
                Bu hafta başarım yok{a.finishBonus ? ` · bitirme bonusu +${a.finishBonus}` : ''}.
              </AppText>
            ) : (
              <View className="flex-row flex-wrap gap-1.5">
                {a.earned.map((k) => {
                  const def = achievementByKey(k);
                  return <NeonStatChip key={k} value={`${def.glyph} ${def.label}`} tone={def.base >= 60 ? 'warning' : 'positive'} />;
                })}
              </View>
            )}
          </GlassCard>

          <GlassCard className="flex-1" contentStyle={{ gap: spacing.xs }}>
            <AppText variant="cardTitle" color={colors.textPrimary}>
              Puan tablosu
            </AppText>
            {standings.slice(0, 5).map((s) => (
              <StandingRow key={s.teamKey} teamKey={s.teamKey} position={s.position} points={s.points} />
            ))}
            {playerRow && playerRow.position > 5 && (
              <View className="border-t border-border-default pt-1">
                <StandingRow teamKey={playerRow.teamKey} position={playerRow.position} points={playerRow.points} />
              </View>
            )}
          </GlassCard>
      </Cols>

      <GlassCard contentStyle={{ gap: spacing.sm }}>
          <View style={{ gap: 2 }}>
            <AppText variant="cardTitle" color={colors.textPrimary}>
              Yarış sonucu
            </AppText>
            <AppText variant="labelSmall" color={colors.textTertiary}>
              {result.laps} tur · {result.wet ? 'yağmurlu' : 'kuru'}
              {result.fastestLap ? ` · en hızlı tur ${result.fastestLap.driver}` : ''}
              {` · ${result.control.yellow} sarı · ${result.control.vsc} VSC · ${result.control.sc} SC${result.control.red ? ` · ${result.control.red} kırmızı` : ''}`}
            </AppText>
            <AppText variant="labelSmall" color={colors.textTertiary}>
              Sıra · sürücü · takım · grid farkı · lidere fark
            </AppText>
          </View>
          <View className="flex-row" style={{ gap: spacing.xl }}>
            {columns.map((col, c) => (
              <View key={c} className="flex-1">
                {col.map((e) => (
                  <View key={`${e.teamKey}-${e.driverIdx}`} className="flex-row items-center gap-2 py-0.5" style={{ opacity: e.dnf ? 0.5 : 1 }}>
                    <Pos n={e.position} lit={e.teamKey === playerTeam.key} />
                    <DriverCell entry={e} dim={e.dnf} />
                    <AppText variant="labelSmall" color={colors.textTertiary} style={{ fontFamily: 'JetBrainsMono_700Bold', width: 30, textAlign: 'right' }}>
                      {e.gridPosition < e.position ? `▼${e.position - e.gridPosition}` : e.gridPosition > e.position ? `▲${e.gridPosition - e.position}` : '—'}
                    </AppText>
                    <AppText variant="labelSmall" color={e.dnf ? semantic.danger : colors.textSecondary} style={{ fontFamily: 'JetBrainsMono_700Bold', width: 56, textAlign: 'right' }}>
                      {fmtGap(e.gapSec)}
                    </AppText>
                  </View>
                ))}
              </View>
            ))}
          </View>
          {!shell.isWide && (
            <Pressable onPress={() => setFullTable((v) => !v)} className="self-start py-1">
              <AppText variant="labelSmall" color={colors.textSecondary}>
                {fullTable ? 'Daha az göster' : `Tüm sonucu göster (${result.order.length} araç)`}
              </AppText>
            </Pressable>
          )}
      </GlassCard>

      {seasonSummary && (
        <GlassCard active contentStyle={{ gap: spacing.sm }}>
          <AppText variant="sectionTitle" color={colors.accentLime} uppercase>
            Sezon {seasonSummary.season} tamamlandı
          </AppText>
          <AppText variant="body" color={colors.textPrimary}>
            Şampiyonada {seasonSummary.playerPosition}. sıra · {seasonSummary.playerPoints} puan · +{seasonSummary.prize} RP şampiyona ödülü
          </AppText>
          <AppText variant="bodySmall" color={colors.textSecondary}>
            {seasonSummary.wins} galibiyet · {seasonSummary.podiums} podyum · {seasonSummary.poles} pole · {seasonSummary.fastestLaps} en hızlı tur · +{seasonSummary.scoreEarned} kariyer skoru
          </AppText>
          <AppText variant="bodySmall" color={colors.textTertiary}>
            Tablo sıfırlandı; araç, fabrika, RP ve sponsorlar yeni sezona taşındı.
          </AppText>
        </GlassCard>
      )}

      <GlassButton
        label={seasonSummary ? 'Yeni sezona başla' : 'Sonraki yarışa geç'}
        onPress={() => {
          haptic.success();
          if (seasonSummary) dismissSeasonSummary();
          nextWeekend();
        }}
      />
    </View>
  );
}

function StandingRow({ teamKey, position, points }: { teamKey: string; position: number; points: number }) {
  const team = teamByKey(teamKey);
  return (
    <View className="flex-row items-center gap-2 py-0.5">
      <Pos n={position} lit={Boolean(team.isPlayer)} />
      <View className="h-3.5 w-1 rounded-full" style={{ backgroundColor: team.colour }} />
      <AppText variant="labelSmall" color={team.isPlayer ? colors.accentLime : colors.textPrimary} style={{ flex: 1 }}>
        {team.name}
      </AppText>
      <AppText variant="labelSmall" color={colors.textSecondary} style={{ fontFamily: 'JetBrainsMono_700Bold' }}>
        {points}
      </AppText>
    </View>
  );
}
