import { View } from 'react-native';
import { colors, spacing } from '@/theme';
import { AppText, GlassCard, Icon, NeonStatChip, type IconName } from '@/components/atoms';
import { useShellLayout } from '@/lib/useShellLayout';

interface PlaceholderScreenProps {
  title: string;
  subtitle: string;
  note: string;
  icon?: IconName;
}

/** Design-system-consistent placeholder for not-yet-built feature screens. */
export function PlaceholderScreen({ title, subtitle, note, icon = 'bolt' }: PlaceholderScreenProps) {
  const shell = useShellLayout();
  return (
    <View
      className="flex-1 justify-center"
      style={{
        paddingLeft: shell.contentPaddingLeft + spacing.sm,
        paddingRight: shell.contentPaddingRight + spacing.sm,
        paddingTop: shell.contentTop,
        paddingBottom: shell.contentPaddingBottom,
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
        <GlassCard active contentStyle={{ gap: spacing.md }}>
          <NeonStatChip value="COMING SOON" tone="info" />
          <AppText variant="body" color={colors.textSecondary}>
            {note}
          </AppText>
        </GlassCard>
      </View>
    </View>
  );
}
