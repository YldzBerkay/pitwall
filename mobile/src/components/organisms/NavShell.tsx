import { useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';
import { colors, layout, spacing } from '@/theme';
import { AppText, Icon, PulseDot, type IconName } from '@/components/atoms';
import { LobbySwitcher } from './LobbySwitcher';
import { useGameStore } from '@/store/gameStore';
import { haptic } from '@/lib/haptics';
import { useShellLayout } from '@/lib/useShellLayout';

/** Minimal structural subset of the tab-bar props we use. */
interface TabBarProps {
  state: {
    index: number;
    routes: { key: string; name: string }[];
  };
  navigation: {
    emit: (event: { type: 'tabPress'; target: string; canPreventDefault: true }) => {
      defaultPrevented: boolean;
    };
    navigate: (name: string) => void;
  };
}

export const routeMeta: Record<string, { label: string; icon: IconName }> = {
  index: { label: 'Garaj', icon: 'manager' },
  'race-week': { label: 'Yarış', icon: 'race-week' },
  development: { label: 'Geliştir', icon: 'development' },
  paddock: { label: 'Padok', icon: 'paddock' },
  sponsors: { label: 'Sponsor', icon: 'sponsors' },
  league: { label: 'Lig', icon: 'league' },
  profile: { label: 'Profil', icon: 'profile' },
};

/**
 * The app shell.
 *
 * Header: team, round and RP, always visible — the manager should never have
 * to hunt for the money. Tab bar: in portrait a floating pill along the
 * bottom where the active tab widens to show its name; in landscape the same
 * pill stands on its side against the edge opposite the dynamic island, so a
 * short screen keeps its height for content.
 */
export function NavShell({ state, navigation }: TabBarProps) {
  const shell = useShellLayout();
  const { insets, isPortrait, navOnRight } = shell;
  const teamName = useGameStore((s) => s.teamName);
  const season = useGameStore((s) => s.season);
  const rp = useGameStore((s) => s.rp);
  const gold = useGameStore((s) => s.gold);
  const authUser = useGameStore((s) => s.auth.user);
  const logout = useGameStore((s) => s.logout);
  const league = useGameStore((s) => s.league);
  const [menuOpen, setMenuOpen] = useState(false);
  const [lobbyOpen, setLobbyOpen] = useState(false);

  const items = state.routes.map((route, index) => {
    const focused = state.index === index;
    const info = routeMeta[route.name] ?? { label: route.name, icon: 'info' as IconName };
    const onPress = () => {
      haptic.select();
      const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
      if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
    };
    return { route, focused, info, onPress };
  });

  // Account/profile is reached from the header menu, never as a race tab —
  // the tab bar stays a pure "what does racing need" surface. It only
  // becomes the lobby switcher while the profile route is actually active.
  const raceItems = items.filter((it) => it.route.name !== 'profile');
  const inAccountMode = state.routes[state.index]?.name === 'profile';
  const goToGame = () => {
    haptic.select();
    navigation.navigate('index');
  };

  return (
    <>
      {/* Header */}
      <View
        className="absolute left-0 right-0 top-0 z-20 flex-row items-center bg-sidebar"
        style={{
          height: layout.headerHeight + insets.top,
          paddingTop: insets.top,
          paddingLeft: insets.left + spacing.lg,
          paddingRight: insets.right + spacing.lg,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.borderDefault,
        }}
      >
        <Pressable
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Hesap menüsü"
          onPress={() => {
            haptic.select();
            setMenuOpen(true);
          }}
          className="h-8 w-8 items-center justify-center rounded-md"
          style={{ backgroundColor: colors.accentSoft }}
        >
          <Icon name="driver" size={18} color={colors.accentLime} />
        </Pressable>
        <View className="ml-2.5 flex-1">
          <AppText variant="label" color={colors.textPrimary} numberOfLines={1}>
            {teamName}
          </AppText>
          <AppText variant="labelSmall" color={colors.textTertiary} numberOfLines={1}>
            Takım müdürü · Sezon {season}
          </AppText>
        </View>
        <View className="flex-row items-center gap-2">
          <Pill icon="coin" value={`${rp}`} unit="RP" tint={colors.accentLime} />
          <Pill icon="gold" value={`${gold}`} unit="Altın" tint={colors.solarAmber} />
        </View>
      </View>

      {/* Tab bar */}
      {isPortrait ? (
        <View
          pointerEvents="box-none"
          className="absolute left-0 right-0 z-20 items-center"
          style={{ bottom: insets.bottom + layout.navEdgeGap }}
        >
          {/* Scrim: content fades out under the pill instead of being cut by it. */}
          <LinearGradient
            pointerEvents="none"
            colors={['rgba(11,12,15,0)', 'rgba(11,12,15,0.92)', colors.bgDeepSpace]}
            locations={[0, 0.55, 1]}
            style={{ position: 'absolute', left: 0, right: 0, top: -48, bottom: -(insets.bottom + layout.navEdgeGap) }}
          />
          <Animated.View layout={LinearTransition.duration(220)} className="flex-row items-center bg-sidebar" style={[styles.pill, { height: layout.tabBarHeight }]}>
            {inAccountMode ? (
              <>
                <Pressable
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel="Oyuna dön"
                  onPress={goToGame}
                  className="h-11 flex-row items-center justify-center rounded-full"
                  style={{ paddingHorizontal: 14, gap: 8 }}
                >
                  <Icon name="chevron-left" size={20} color={colors.textSecondary} />
                  <AppText variant="labelSmall" color={colors.textSecondary} style={styles.tabLabel}>
                    Oyuna dön
                  </AppText>
                </Pressable>
                <Pressable
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel="Lobi"
                  onPress={() => {
                    haptic.select();
                    setLobbyOpen(true);
                  }}
                  className="h-11 flex-row items-center justify-center rounded-full"
                  style={{ paddingHorizontal: 14, gap: 8, backgroundColor: league.connected ? colors.accentSoft : 'transparent' }}
                >
                  <PulseDot color={league.connected ? colors.matrixGreen : colors.textTertiary} size={8} periodMs={1400} />
                  <AppText variant="labelSmall" color={league.connected ? colors.accentLime : colors.textSecondary} style={styles.tabLabel}>
                    Lobi
                  </AppText>
                </Pressable>
              </>
            ) : (
              raceItems.map(({ route, focused, info, onPress }) => (
                <Pressable
                  key={route.key}
                  hitSlop={6}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: focused }}
                  accessibilityLabel={info.label}
                  onPress={onPress}
                  className="h-11 flex-row items-center justify-center rounded-full"
                  style={{
                    paddingHorizontal: focused ? 14 : shell.width < 390 ? 10 : 11,
                    gap: 8,
                    backgroundColor: focused ? colors.accentLime : 'transparent',
                  }}
                >
                  <Icon name={info.icon} size={20} color={focused ? colors.onAccent : colors.textSecondary} />
                  {focused && (
                    <Animated.View entering={FadeIn.duration(180)}>
                      <AppText variant="labelSmall" color={colors.onAccent} style={styles.tabLabel}>
                        {info.label}
                      </AppText>
                    </Animated.View>
                  )}
                </Pressable>
              ))
            )}
          </Animated.View>
        </View>
      ) : (
        <View
          pointerEvents="box-none"
          className="absolute bottom-0 z-20 justify-center"
          style={[{ top: layout.headerHeight + insets.top }, navOnRight ? { right: insets.right + layout.navEdgeGap } : { left: insets.left + layout.navEdgeGap }]}
        >
          <View className="items-center bg-sidebar" style={[styles.pill, styles.capsule, { width: layout.navCapsuleWidth }]}>
            {inAccountMode ? (
              <>
                <Pressable
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel="Oyuna dön"
                  onPress={goToGame}
                  className="items-center justify-center rounded-full"
                  style={{ width: layout.navItemSize, height: layout.navItemSize }}
                >
                  <Icon name="chevron-left" size={19} color={colors.textSecondary} />
                </Pressable>
                <Pressable
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel="Lobi"
                  onPress={() => {
                    haptic.select();
                    setLobbyOpen(true);
                  }}
                  className="items-center justify-center rounded-full"
                  style={{ width: layout.navItemSize, height: layout.navItemSize, backgroundColor: league.connected ? colors.accentSoft : 'transparent' }}
                >
                  <Icon name="league" size={19} color={league.connected ? colors.accentLime : colors.textSecondary} />
                </Pressable>
              </>
            ) : (
              raceItems.map(({ route, focused, info, onPress }) => (
                <Pressable
                  key={route.key}
                  hitSlop={6}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: focused }}
                  accessibilityLabel={info.label}
                  onPress={onPress}
                  className="items-center justify-center rounded-full"
                  style={{
                    width: layout.navItemSize,
                    height: layout.navItemSize,
                    backgroundColor: focused ? colors.accentLime : 'transparent',
                  }}
                >
                  <Icon name={info.icon} size={19} color={focused ? colors.onAccent : colors.textSecondary} />
                </Pressable>
              ))
            )}
          </View>
        </View>
      )}

      {/* Account menu — the only way to reach Profile; it is not a race tab. */}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable onPress={() => setMenuOpen(false)} style={{ flex: 1 }}>
          <View
            className="absolute overflow-hidden rounded-lg border bg-elevated"
            style={{
              top: insets.top + layout.headerHeight - 4,
              left: insets.left + spacing.lg,
              width: 240,
              borderColor: colors.borderDefault,
            }}
          >
            <MenuRow
              icon="profile"
              label="Profilim"
              onPress={() => {
                setMenuOpen(false);
                navigation.navigate('profile');
              }}
            />
            <MenuRow
              icon="settings"
              label="Ayarlar"
              onPress={() => {
                setMenuOpen(false);
                router.push('/settings');
              }}
            />
            <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.borderDefault }} />
            {authUser ? (
              <View className="flex-row items-center justify-between px-3.5 py-3">
                <Pressable
                  style={{ flex: 1 }}
                  onPress={() => {
                    setMenuOpen(false);
                    haptic.select();
                    router.push('/auth');
                  }}
                >
                  <AppText variant="label" color={colors.textPrimary} numberOfLines={1}>
                    {authUser.nickname}
                  </AppText>
                  <AppText variant="labelSmall" color={colors.textTertiary}>
                    Hesap
                  </AppText>
                </Pressable>
                <Pressable
                  hitSlop={8}
                  onPress={() => {
                    setMenuOpen(false);
                    haptic.select();
                    logout();
                  }}
                >
                  <AppText variant="labelSmall" color={colors.neonCoral} uppercase>
                    Çıkış
                  </AppText>
                </Pressable>
              </View>
            ) : (
              <MenuRow
                icon="profile"
                label="Giriş yap"
                onPress={() => {
                  setMenuOpen(false);
                  router.push('/auth');
                }}
              />
            )}
          </View>
        </Pressable>
      </Modal>

      <LobbySwitcher visible={lobbyOpen} onClose={() => setLobbyOpen(false)} />
    </>
  );
}

function MenuRow({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  return (
    <Pressable
      className="flex-row items-center gap-2.5 px-3.5 py-3"
      onPress={() => {
        haptic.select();
        onPress();
      }}
    >
      <Icon name={icon} size={17} color={colors.textSecondary} />
      <AppText variant="label" color={colors.textPrimary}>
        {label}
      </AppText>
    </Pressable>
  );
}

function Pill({ icon, value, unit, tint }: { icon: IconName; value: string; unit: string; tint: string }) {
  return (
    <View className="flex-row items-center gap-1.5 rounded-full border px-2.5 py-1" style={{ borderColor: 'rgba(255,255,255,0.1)', backgroundColor: 'rgba(255,255,255,0.04)' }}>
      <Icon name={icon} size={13} color={tint} />
      <AppText variant="statSmall" color={colors.textPrimary} style={{ fontSize: 13, lineHeight: 16 }}>
        {value}
      </AppText>
      <AppText variant="labelSmall" color={colors.textSecondary} style={{ fontSize: 10, lineHeight: 12 }}>
        {unit}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 6,
    gap: 2,
    shadowColor: '#000000',
    shadowOpacity: 0.5,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
  },
  capsule: {
    paddingVertical: 8,
    paddingHorizontal: 0,
    gap: 4,
  },
  tabLabel: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 12,
    lineHeight: 14,
  },
});
