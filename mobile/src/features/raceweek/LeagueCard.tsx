import { View } from 'react-native';
import { colors, spacing } from '@/theme';
import { AppText, GlassCard } from '@/components/atoms';
import { useGameStore } from '@/store/gameStore';

/**
 * Shows the connection state of the player's active lobby race
 * (`raceSlice.ts`'s `race.status`) — there is no server address to type
 * anymore, the base URL lives in `authSlice`, and the connection itself is
 * driven by `lobbySlice.ts`'s `setActiveSlot` (`connectRace`). This card is
 * read-only: a status line and, once a lap has arrived, the lap count.
 */
export function LeagueCard() {
  const race = useGameStore((s) => s.race);

  const label = (): string => {
    switch (race.status) {
      case 'signed-out':
        return 'Giriş yapılmadı';
      case 'session-invalid':
        return 'Oturum süresi doldu · tekrar giriş yap';
      case 'connecting':
        return 'Bağlanıyor…';
      case 'connected':
        return race.data ? `Bağlı · tur ${race.data.lap}` : 'Bağlı';
      case 'disconnected':
        return 'Bağlantı koptu';
      case 'idle':
      default:
        return 'Aktif yarış yok';
    }
  };

  const tint = (): string => {
    switch (race.status) {
      case 'connected':
        return colors.matrixGreen;
      case 'connecting':
        return colors.textTertiary;
      case 'signed-out':
      case 'session-invalid':
      case 'disconnected':
        return colors.neonCoral;
      case 'idle':
      default:
        return colors.textTertiary;
    }
  };

  return (
    <GlassCard active={race.status === 'connected'} contentStyle={{ gap: spacing.sm }}>
      <View className="flex-row items-center justify-between">
        <View>
          <AppText variant="cardTitle" color={colors.textPrimary}>
            Çevrimiçi lig
          </AppText>
          <AppText variant="labelSmall" color={colors.textTertiary}>
            Diğer yöneticilerle aynı saatte, aynı yarışta
          </AppText>
        </View>
        <AppText variant="labelSmall" color={tint()} uppercase>
          {label()}
        </AppText>
      </View>

      {race.lastPitOutcome && !race.lastPitOutcome.ok && (
        <AppText variant="labelSmall" color={colors.neonCoral}>
          Pit çağrısı reddedildi: {race.lastPitOutcome.error}
        </AppText>
      )}
      {race.lastWeekendChoiceOutcome && !race.lastWeekendChoiceOutcome.ok && (
        <AppText variant="labelSmall" color={colors.neonCoral}>
          Gönderilemedi: {race.lastWeekendChoiceOutcome.error}
        </AppText>
      )}
    </GlassCard>
  );
}
