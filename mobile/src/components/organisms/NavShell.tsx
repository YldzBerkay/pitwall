import { LayoutAnimation, Platform, Pressable, UIManager, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, layout, spacing } from '@/theme';
import { AppText, Icon, type IconName } from '@/components/atoms';
import { useGameStore } from '@/store/gameStore';
import { haptic } from '@/lib/haptics';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

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

const meta: Record<string, { label: string; icon: IconName }> = {
  'race-week': { label: 'Race Week', icon: 'race-week' },
  index: { label: 'Manager', icon: 'manager' },
  league: { label: 'League', icon: 'league' },
  profile: { label: 'Profile', icon: 'profile' },
};

/**
 * App shell for the landscape layout: a slim top header plus a collapsible
 * left side-nav. The header's menu button expands/collapses the nav between a
 * labelled panel and a compact icon rail.
 */
export function NavShell({ state, navigation }: TabBarProps) {
  const insets = useSafeAreaInsets();
  const { teamName, round, totalRounds, rp, navCollapsed, toggleNav } = useGameStore();
  const navWidth = navCollapsed ? layout.navCollapsed : layout.navExpanded;

  // Place the side-nav on the opposite side of the dynamic island / notch.
  // In landscape the safe-area inset is larger on whichever side the island
  // sits, so we anchor the nav to the side with the smaller inset.
  const navOnRight = insets.right > insets.left;
  const navSafeInset = navOnRight ? insets.right : insets.left;

  const onToggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.create(180, 'easeInEaseOut', 'opacity'));
    haptic.select();
    toggleNav();
  };

  return (
    <>
      {/* Header */}
      <View
        className="absolute left-0 right-0 top-0 z-20 flex-row items-center border-b border-border-default bg-sidebar"
        style={{
          height: layout.headerHeight + insets.top,
          paddingTop: insets.top,
          paddingLeft: insets.left + spacing.lg,
          paddingRight: insets.right + spacing.lg,
        }}
      >
        <Pressable
          onPress={onToggle}
          hitSlop={8}
          className="h-9 w-9 items-center justify-center rounded-md border border-border-default bg-glass-strong"
        >
          <Icon name="menu" size={20} color={colors.textSecondary} />
        </Pressable>

        <View className="ml-3 h-8 w-8 items-center justify-center rounded-md bg-accent">
          <AppText variant="labelSmall" color={colors.textPrimary}>
            PW
          </AppText>
        </View>
        <View className="ml-2.5 flex-1">
          <AppText variant="label" color={colors.textPrimary} uppercase numberOfLines={1}>
            {teamName}
          </AppText>
          <AppText variant="labelSmall" color={colors.textTertiary} uppercase>
            Pit Wall · GM
          </AppText>
        </View>

        <View className="flex-row items-center gap-2.5">
          <View className="rounded-md border border-border-default px-3 py-1.5">
            <AppText variant="labelSmall" color={colors.textSecondary} uppercase>
              R{round}/{totalRounds}
            </AppText>
          </View>
          <View className="flex-row items-baseline gap-1.5 rounded-md border border-border-active bg-accent-soft px-3 py-1.5">
            <AppText variant="statSmall" color={colors.accentBlueLight}>
              {rp}
            </AppText>
            <AppText variant="labelSmall" color={colors.textSecondary} uppercase>
              RP
            </AppText>
          </View>
        </View>
      </View>

      {/* Collapsible side-nav (opposite side of the dynamic island) */}
      <View
        className={`absolute z-10 bg-sidebar ${
          navOnRight ? 'right-0 border-l border-border-default' : 'left-0 border-r border-border-default'
        }`}
        style={{
          top: layout.headerHeight + insets.top,
          bottom: 0,
          width: navWidth + navSafeInset,
          paddingLeft: (navOnRight ? spacing.sm : navSafeInset + spacing.sm),
          paddingRight: (navOnRight ? navSafeInset + spacing.sm : spacing.sm),
          paddingTop: spacing.md,
          paddingBottom: insets.bottom + spacing.md,
        }}
      >
        <View className="gap-1.5">
          {state.routes.map((route, index) => {
            const focused = state.index === index;
            const info = meta[route.name] ?? { label: route.name, icon: 'manager' as IconName };
            const tint = focused ? colors.accentBlueLight : colors.textSecondary;

            return (
              <Pressable
                key={route.key}
                hitSlop={6}
                className={`h-11 flex-row items-center rounded-md ${
                  navCollapsed ? 'justify-center' : 'gap-3 px-3'
                } ${focused ? 'border border-border-active bg-accent-soft' : ''}`}
                onPress={() => {
                  haptic.select();
                  const event = navigation.emit({
                    type: 'tabPress',
                    target: route.key,
                    canPreventDefault: true,
                  });
                  if (!focused && !event.defaultPrevented) {
                    navigation.navigate(route.name);
                  }
                }}
              >
                <Icon name={info.icon} size={22} color={tint} />
                {!navCollapsed && (
                  <AppText variant="label" color={tint} numberOfLines={1}>
                    {info.label}
                  </AppText>
                )}
              </Pressable>
            );
          })}
        </View>
      </View>
    </>
  );
}
