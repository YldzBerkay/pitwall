import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { colors, spacing } from '@/theme';
import { semanticColors } from '@/theme/colors';
import { AppText, GlassCard, Cols } from '@/components/atoms';
import { playerTeam } from '@pitwall/shared/teams';
import { brandByKey } from '@pitwall/shared/sponsors';
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
 * ── WHAT THIS SHEET NO LONGER SHOWS, AND WHY ──────────────────────────────
 * Achievements, the career record and the season summary came from
 * `settleRaceWeekend`'s call into `scoreWeekend`/`recordWeekend`/
 * `summariseSeason`. None of those exist server-side yet, so rather than
 * score a career off a race this device did not run, they are simply absent
 * until a later phase adds them to the server. See the commit that removed
 * the local engine for the full list.
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
