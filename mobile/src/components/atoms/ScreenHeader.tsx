import type { ReactNode } from 'react';
import { View } from 'react-native';
import { colors } from '@/theme';
import { useShellLayout } from '@/lib/useShellLayout';
import { AppText } from './Typography';
import { Icon, type IconName } from './Icon';

interface ScreenHeaderProps {
  /** Big display title, sentence case: "Yarış haftası". */
  title: string;
  /** One plain sentence saying what this screen is for and what to do here. */
  subtitle: string;
  /** Small tag above the title: "Sezon 1 · Tur 7/23". */
  eyebrow?: string;
  icon?: IconName;
  /** Controls on the right (wide) or below (narrow): a segment, a chip, a small stat. */
  right?: ReactNode;
}

/**
 * Every screen opens with this: what the screen is, why the manager is here.
 * The reference apps lead with a heavy title and a quiet explainer; the
 * eyebrow carries the game clock so the player always knows where in the
 * season they stand. On a phone in portrait the controls drop under the
 * text instead of squeezing the title.
 */
export function ScreenHeader({ title, subtitle, eyebrow, icon, right }: ScreenHeaderProps) {
  const { isWide } = useShellLayout();
  const text = (
    <View className="flex-1" style={{ gap: 2 }}>
      {eyebrow && (
        <View className="flex-row items-center gap-1.5">
          {icon && <Icon name={icon} size={13} color={colors.textSecondary} />}
          <AppText variant="labelSmall" color={colors.textSecondary} uppercase numberOfLines={1} style={{ flexShrink: 1 }}>
            {eyebrow}
          </AppText>
        </View>
      )}
      <AppText variant="pageTitle" color={colors.textPrimary} style={{ letterSpacing: 0.2 }}>
        {title}
      </AppText>
      <AppText variant="bodySmall" color={colors.textSecondary} numberOfLines={2} style={{ maxWidth: 560 }}>
        {subtitle}
      </AppText>
    </View>
  );
  if (isWide || !right) {
    return (
      <View className="flex-row items-end justify-between" style={{ gap: 12 }}>
        {text}
        {right}
      </View>
    );
  }
  return (
    <View style={{ gap: 12 }}>
      {text}
      <View className="flex-row"><View style={{ flex: 1 }}>{right}</View></View>
    </View>
  );
}
