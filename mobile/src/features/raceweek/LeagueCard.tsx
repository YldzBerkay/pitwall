import { useEffect, useState } from 'react';
import { TextInput, View } from 'react-native';
import { colors, spacing } from '@/theme';
import { AppText, GlassButton, GlassCard } from '@/components/atoms';
import { useGameStore } from '@/store/gameStore';
import { haptic } from '@/lib/haptics';
import { Chip } from './shared';

const DEFAULT_URL = 'http://localhost:8787';

const fmt = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}sa ${m}dk` : `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
};

/**
 * Online league: connect, see the clock, check in inside the window. The
 * race itself then arrives lap by lap from the server into the same live
 * panel the offline weekend uses.
 */
export function LeagueCard() {
  const league = useGameStore((s) => s.league);
  const connectLeague = useGameStore((s) => s.connectLeague);
  const disconnectLeague = useGameStore((s) => s.disconnectLeague);
  const leagueCheckIn = useGameStore((s) => s.leagueCheckIn);
  const syncLeagueWeekend = useGameStore((s) => s.syncLeagueWeekend);
  const [url, setUrl] = useState(league.url ?? DEFAULT_URL);
  const [now, setNow] = useState(() => Date.now());
  const [note, setNote] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const st = league.state;
  const toStart = st ? st.raceStartAt - now : 0;
  const toCheckin = st ? st.checkinOpensAt - now : 0;
  const claimed = st?.teams.filter((t) => t.claimed).length ?? 0;
  const checkedIn = st?.teams.filter((t) => t.checkedIn).length ?? 0;

  return (
    <GlassCard active={league.connected} contentStyle={{ gap: spacing.sm }}>
      <View className="flex-row items-center justify-between">
        <View>
          <AppText variant="cardTitle" color={colors.textPrimary}>
            Çevrimiçi lig
          </AppText>
          <AppText variant="labelSmall" color={colors.textTertiary}>
            Diğer yöneticilerle aynı saatte, aynı yarışta
          </AppText>
        </View>
        <AppText variant="labelSmall" color={league.connected ? colors.matrixGreen : colors.textTertiary} uppercase>
          {league.connected ? `Bağlı · ${claimed}/11 takım · ${checkedIn} giriş` : 'Bağlı değil'}
        </AppText>
      </View>

      {!league.connected && !open ? (
        <Chip label="Lige bağlan" selected compact onPress={() => setOpen(true)} />
      ) : !league.connected ? (
        <View className="flex-row items-center" style={{ gap: spacing.sm }}>
          <TextInput
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Lig sunucusu adresi"
            placeholderTextColor={colors.textTertiary}
            style={{ flex: 1, color: colors.textPrimary, borderColor: colors.borderDefault, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontFamily: 'JetBrainsMono_700Bold', fontSize: 12 }}
          />
          <Chip label="Bağlan" selected compact onPress={() => { haptic.medium(); void connectLeague(url); }} />
        </View>
      ) : st ? (
        <>
          <AppText variant="bodySmall" color={colors.textSecondary}>
            Sezon {st.season} · {st.round}. yarış · {st.track.gp} · {st.track.laps} tur ·{' '}
            {st.phase === 'live'
              ? 'Yarış canlı'
              : st.phase === 'checkin'
                ? `Giriş açık · yarış ${fmt(toStart)} sonra`
                : `Yarış ${fmt(toStart)} sonra · giriş ${fmt(toCheckin)} sonra açılır`}
          </AppText>
          <View style={{ gap: spacing.sm }}>
            <GlassButton
              label={league.checkedIn ? 'Giriş yapıldı · duvardasın' : st.phase === 'checkin' ? 'Yarışa giriş yap' : 'Giriş penceresi kapalı'}
              disabled={league.checkedIn || st.phase !== 'checkin'}
              className="flex-1"
              onPress={async () => {
                const r = await leagueCheckIn();
                setNote(r === 'ok' ? 'Duvardasın: yarışı sen yöneteceksin.' : r === 'closed' ? 'Pencere kapalı; yardımcı yönetecek.' : `Hata: ${r}`);
                if (r === 'ok') haptic.success(); else haptic.error();
              }}
            />
            <View className="flex-row flex-wrap" style={{ gap: spacing.sm }}>
              <Chip label="Ayarları gönder" selected={false} compact onPress={() => { void syncLeagueWeekend(); setNote('Araç ayarı, lastik, taktik ve risk sunucuya gönderildi.'); }} />
              <Chip label="Ayrıl" selected={false} compact tint={colors.neonCoral} onPress={disconnectLeague} />
            </View>
          </View>
          <AppText variant="labelSmall" color={colors.textTertiary}>
            Yarıştan 5 dk önce giriş yapmayan takımı yardımcı bot yönetir. Yarış herkes için aynı saatte, aynı hızda.
          </AppText>
          {league.lastResult && (
            <AppText variant="labelSmall" color={colors.accentLime}>
              Son lig yarışı: {league.lastResult.order.slice(0, 3).map((e) => e.driver).join(', ')} · biz P{league.lastResult.playerFinish || 'DNF'}
            </AppText>
          )}
        </>
      ) : null}

      {(note || league.error) && (
        <AppText variant="labelSmall" color={league.error ? colors.neonCoral : colors.accentLime}>
          {league.error ?? note}
        </AppText>
      )}
    </GlassCard>
  );
}
