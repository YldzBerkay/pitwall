import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { colors, spacing } from '@/theme';
import { semanticColors } from '@/theme/colors';
import { AppText, GlassCard, Cols } from '@/components/atoms';
import { playerTeam } from '@pitwall/shared/teams';
import { brandByKey } from '@pitwall/shared/sponsors';
import { achievementByKey } from '@pitwall/shared/achievements';
import { useGameStore } from '@/store/gameStore';
import { displayRace } from '@/store/slices/raceSlice';
import { displaySettlement } from '@/store/slices/settlementDisplay';
import { useShellLayout } from '@/lib/useShellLayout';
import { DriverCell, Pos, fmtGap } from './shared';

/**
 * The weekend's receipt: the classification the server ran, and the payment
 * the server made.
 *
 * ── EVERY NUMBER HERE IS READ, NONE IS COMPUTED ───────────────────────────
 * This sheet used to render `weekend.result` and `weekend.settlement` — the
 * output of the local engine's `finishRace` and the local
 * `settleRaceWeekend`. Both are gone. The classification is the last race
 * image the socket delivered (frozen at the flag, `displayRace`), and the
 * money is the server's own persisted per-seat breakdown
 * (`GET /economy/settlement` via `displaySettlement`), which it wrote in the
 * same transaction that paid the player.
 *
 * ── ACHIEVEMENTS ARE BACK, FROM THE SERVER ────────────────────────────────
 * The season summary is still absent (no server-side `summariseSeason` yet).
 * Achievements and the career score they added are not: the server now runs
 * `scoreWeekend`/`recordWeekend` itself at settlement, in the same
 * transaction as the payment (`server/src/economy/settle.ts`), and
 * `GET /economy/settlement` hands the result back alongside the money
 * (`payout.achievementsEarned`/`payout.careerScore`,
 * `server/src/economy/settlementRepo.ts`). Only EARNED achievements are ever
 * listed here — the server does not expose why an unearned one (Clean
 * Sweep, most often) was denied, so this sheet does not guess at a reason
 * either; see `shared/src/achievements.ts`'s `denyCleanSweep` for the two
 * cases (a sprint weekend, a practice session never frozen) neither of
 * which reaches this response.
 */
export function RaceResultSheet() {
  const shell = useShellLayout();
  const colorblindMode = useGameStore((s) => s.colorblindMode);
  const semantic = semanticColors(colorblindMode);
  const [fullTable, setFullTable] = useState(false);

  const raceSlice = useGameStore((s) => s.race);
  const settlementApi = useGameStore((s) => s.settlementApi);
  const display = displayRace<undefined>(raceSlice, undefined);
  const race = display.kind === 'server' ? display.race : undefined;
  const paid = displaySettlement(raceSlice.lobbyId, settlementApi, raceSlice.roundNo);

  const moneyCard = (
    <GlassCard active className="flex-1" contentStyle={{ gap: spacing.sm }}>
      <AppText variant="cardTitle" color={colors.textPrimary}>
        Kazanç
      </AppText>
      {paid.kind === 'ready' ? (
        <>
          <View className="flex-row items-baseline gap-2">
            <AppText variant="statLarge" color={colors.accentLime}>
              +{paid.total}
            </AppText>
            <AppText variant="label" color={colors.textSecondary}>
              RP
            </AppText>
          </View>
          <AppText variant="bodySmall" color={colors.textSecondary}>
            {paid.round}. yarış · {paid.position}. sıra · {paid.prize} RP yarış ödülü
            {paid.sponsorIncome ? ` · sponsor geliri ${paid.sponsorIncome} RP` : ''}
            {paid.briefBonus ? ` · brifing +${paid.briefBonus} RP` : ' · brifingden öneri tutmadı'}
            {paid.bonusesEarned.length
              ? ` · hedef bonusu: ${paid.bonusesEarned.map((k) => brandByKey(k)?.short).filter(Boolean).join(', ')}`
              : ''}
            {paid.streaksBroken.length
              ? ` · seri bozuldu: ${paid.streaksBroken.map((k) => brandByKey(k)?.short).filter(Boolean).join(', ')}`
              : ''}
            {paid.expired.length ? ` · ${paid.expired.length} sözleşme bitti` : ''}
          </AppText>
          {paid.achievements.length > 0 && (
            <View className="flex-row flex-wrap gap-1.5">
              {paid.achievements.map((key) => (
                <View
                  key={key}
                  className="flex-row items-center gap-1 rounded-sm border px-1.5 py-0.5"
                  style={{ borderColor: colors.accentLime }}
                >
                  <AppText variant="labelSmall" color={colors.accentLime} style={{ fontFamily: 'JetBrainsMono_700Bold' }}>
                    {achievementByKey(key).glyph}
                  </AppText>
                  <AppText variant="labelSmall" color={colors.textPrimary}>
                    {achievementByKey(key).label}
                  </AppText>
                </View>
              ))}
              <AppText variant="labelSmall" color={colors.textSecondary}>
                · kariyere +{paid.careerScore} puan
              </AppText>
            </View>
          )}
        </>
      ) : (
        <AppText variant="bodySmall" color={colors.textTertiary}>
          {paid.kind === 'none'
            ? 'Bu yarışın ödemesi henüz yapılmadı.'
            : paid.kind === 'loading'
              ? 'Yarışın dökümü sunucudan alınıyor…'
              : 'Bir lige bağlı değilsin; gösterilecek bir ödeme yok.'}
        </AppText>
      )}
    </GlassCard>
  );

  if (!race) {
    return (
      <View style={{ gap: spacing.lg }}>
        <GlassCard>
          <AppText variant="cardTitle" color={colors.textPrimary}>
            Sınıflandırma alınamadı
          </AppText>
          <AppText variant="bodySmall" color={colors.textTertiary}>
            Yarışın son görüntüsü bu cihaza ulaşmadı. Lobiye yeniden bağlanınca burada görünecek — sonuç
            sunucuda zaten yazılı, bu ekran onu yerel olarak yeniden hesaplamaz.
          </AppText>
        </GlassCard>
        {moneyCard}
      </View>
    );
  }

  // Narrow screens: the podium zone plus our cars, unless expanded.
  const shownOrder = shell.isWide || fullTable ? race.cars : race.cars.filter((c) => c.position <= 6 || c.isPlayer);
  const half = shell.isWide ? Math.ceil(shownOrder.length / 2) : shownOrder.length;
  const columns = shell.isWide ? [shownOrder.slice(0, half), shownOrder.slice(half)] : [shownOrder];
  const ours = race.cars.filter((c) => c.isPlayer).sort((a, b) => a.driverIdx - b.driverIdx);

  return (
    <View style={{ gap: spacing.lg }}>
      <Cols>
        {moneyCard}

        <GlassCard className="flex-1" contentStyle={{ gap: spacing.sm }}>
          <AppText variant="cardTitle" color={colors.textPrimary}>
            Bizim araçlar
          </AppText>
          <AppText variant="bodySmall" color={colors.textSecondary}>
            {ours.map((c) => `${c.driver.split(' ').pop()} ${c.dnf ? 'yarış dışı' : `${c.position}.`}`).join(' · ')}
          </AppText>
          {race.fastestLap && (
            <AppText variant="labelSmall" color={semantic.record}>
              En hızlı tur · {race.fastestLap.driver}
            </AppText>
          )}
        </GlassCard>
      </Cols>

      <GlassCard contentStyle={{ gap: spacing.sm }}>
        <AppText variant="cardTitle" color={colors.textPrimary}>
          Sınıflandırma
        </AppText>
        <View className="flex-row" style={{ gap: spacing.lg }}>
          {columns.map((col, c) => (
            <View key={c} className="flex-1">
              {col.map((e) => (
                <View key={`${e.teamKey}-${e.driverIdx}`} className="flex-row items-center gap-2 py-0.5" style={{ opacity: e.dnf ? 0.45 : 1 }}>
                  <Pos n={e.position} lit={e.teamKey === playerTeam.key} />
                  <DriverCell entry={e} dim={e.dnf} />
                  <AppText
                    variant="labelSmall"
                    color={e.dnf ? semantic.danger : colors.textTertiary}
                    numberOfLines={1}
                    style={{ fontFamily: 'JetBrainsMono_700Bold', width: 68, textAlign: 'right' }}
                  >
                    {e.dnf ? 'DNF' : fmtGap(e.position === 1 ? 0 : e.totalSec - race.cars[0].totalSec)}
                  </AppText>
                </View>
              ))}
            </View>
          ))}
        </View>
        {!shell.isWide && (
          <Pressable onPress={() => setFullTable((v) => !v)} className="self-start py-1">
            <AppText variant="labelSmall" color={colors.textSecondary}>
              {fullTable ? 'Daha az göster' : `Tüm sınıflandırmayı göster (${race.cars.length} araç)`}
            </AppText>
          </Pressable>
        )}
      </GlassCard>
    </View>
  );
}
