import { useState } from 'react';
import { Modal, Pressable, TextInput, View } from 'react-native';
import { colors, radius, spacing } from '@/theme';
import { AppText, GlassButton, GlassCard, PulseDot } from '@/components/atoms';
import { useGameStore } from '@/store/gameStore';
import { haptic } from '@/lib/haptics';

const DEFAULT_URL = 'http://localhost:8787';

/**
 * The "which lobby am I in" area — reached from the account/profile
 * navigation, not from the race-week tabs. Today there is only ever one
 * lobby connection (a manual server address, `leagueSlice.ts`); this is
 * deliberately scoped to that single connection. The 5-slot lobby system
 * from `docs/superpowers/specs/2026-09-19-cok-oyunculu-kabuk-tasarim.md`
 * (3 free + 2 paid slots, matchmaking, per-lobby economy) is a written spec
 * only — no server DB, no matchmaking, no slot purchase exists yet. That is
 * a separate, much larger project; this modal is not a placeholder for it,
 * it is the real (single-lobby) control surface moved to where the account
 * area expects to find it.
 */
export function LobbySwitcher({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const league = useGameStore((s) => s.league);
  const connectLeague = useGameStore((s) => s.connectLeague);
  const disconnectLeague = useGameStore((s) => s.disconnectLeague);
  const [url, setUrl] = useState(league.url ?? DEFAULT_URL);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{ flex: 1, backgroundColor: 'rgba(11,12,15,0.72)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl }}
      >
        <Pressable onPress={() => {}}>
          <GlassCard active={league.connected} style={{ width: 320 }} contentStyle={{ gap: spacing.md }}>
            <View className="flex-row items-center gap-2">
              <PulseDot color={league.connected ? colors.matrixGreen : colors.textTertiary} size={8} periodMs={1400} />
              <AppText variant="cardTitle" color={colors.textPrimary}>
                Lobi
              </AppText>
            </View>
            {league.connected ? (
              <>
                <AppText variant="bodySmall" color={colors.textSecondary} numberOfLines={1}>
                  Bağlı · {league.url}
                </AppText>
                {league.state && (
                  <AppText variant="labelSmall" color={colors.textTertiary}>
                    Sezon {league.state.season} · {league.state.round}. yarış · {league.state.track.gp}
                  </AppText>
                )}
                <GlassButton
                  label="Ayrıl"
                  variant="outline"
                  style={{ borderColor: colors.neonCoral }}
                  onPress={() => {
                    haptic.select();
                    disconnectLeague();
                  }}
                />
              </>
            ) : (
              <>
                <AppText variant="bodySmall" color={colors.textSecondary}>
                  Tekrar girmek istediğin lobinin sunucu adresini gir.
                </AppText>
                <TextInput
                  value={url}
                  onChangeText={setUrl}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="Lobi sunucusu adresi"
                  placeholderTextColor={colors.textTertiary}
                  style={{
                    color: colors.textPrimary,
                    borderColor: colors.borderDefault,
                    borderWidth: 1,
                    borderRadius: radius.sm,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    fontFamily: 'JetBrainsMono_700Bold',
                    fontSize: 12,
                  }}
                />
                {league.error && (
                  <AppText variant="bodySmall" color={colors.neonCoral}>
                    {league.error}
                  </AppText>
                )}
                <GlassButton
                  label="Bağlan"
                  onPress={() => {
                    haptic.medium();
                    void connectLeague(url);
                  }}
                />
              </>
            )}
          </GlassCard>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
