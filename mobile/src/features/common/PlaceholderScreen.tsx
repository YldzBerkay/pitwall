import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, layout, spacing } from '@/theme';
import { AppText, GlassCard, Icon, NeonStatChip, type IconName } from '@/components/atoms';
import { useGameStore } from '@/store/gameStore';

interface PlaceholderScreenProps {
  title: string;
  subtitle: string;
  note: string;
  icon?: IconName;
}

/** Design-system-consistent placeholder for not-yet-built feature screens. */
export function PlaceholderScreen({ title, subtitle, note, icon = 'bolt' }: PlaceholderScreenProps) {
  const insets = useSafeAreaInsets();
  const navCollapsed = useGameStore((s) => s.navCollapsed);
  const navWidth = navCollapsed ? layout.navCollapsed : layout.navExpanded;
  return (
    <View
      className="flex-1 justify-center"
      style={{
        paddingLeft: navWidth + insets.left + spacing.xxl,
        paddingRight: insets.right + spacing.xxl,
        paddingTop: layout.headerHeight + insets.top + spacing.xl,
        paddingBottom: insets.bottom + spacing.xl,
      }}
    >
      <View className="max-w-[520px]">
        <View className="mb-4 flex-row items-center gap-3">
          <Icon name={icon} size={30} color={colors.accentBlueLight} />
          <AppText variant="pageTitle" uppercase>
            {title}
          </AppText>
        </View>
        <AppText variant="body" color={colors.textSecondary} className="mb-6">
          {subtitle}
        </AppText>
        <GlassCard active className="gap-3">
          <NeonStatChip value="COMING SOON" tone="info" />
          <AppText variant="body" color={colors.textSecondary}>
            {note}
          </AppText>
        </GlassCard>
      </View>
    </View>
  );
}
