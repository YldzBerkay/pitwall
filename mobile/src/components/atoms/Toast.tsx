import { memo, useEffect } from 'react';
import { View } from 'react-native';
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { colors, radius, spacing } from '@/theme';
import { AppText } from './Typography';
import { Icon, type IconName } from './Icon';

export type ToastTone = 'positive' | 'attention' | 'danger' | 'info';

interface ToastProps {
  visible: boolean;
  message: string;
  tone?: ToastTone;
  icon?: IconName;
  onDismiss?: () => void;
  durationMs?: number;
}

const toneColor: Record<ToastTone, string> = {
  positive: colors.matrixGreen,
  attention: colors.solarAmber,
  danger: colors.neonCoral,
  info: colors.infoBlue,
};

/**
 * Non-blocking notification (reward, achievement, connection warning). Never
 * stacks — one toast replaces the previous one — and auto-dismisses so it
 * never becomes a forced-close popup like the guide warns against.
 */
export const Toast = memo(function Toast({ visible, message, tone = 'info', icon, onDismiss, durationMs = 3000 }: ToastProps) {
  const y = useSharedValue(-40);
  const opacity = useSharedValue(0);

  useEffect(() => {
    if (!visible) return;
    y.value = withTiming(0, { duration: 260, easing: Easing.out(Easing.cubic) });
    opacity.value = withTiming(1, { duration: 200 });
    const id = setTimeout(() => {
      opacity.value = withTiming(0, { duration: 200 });
      y.value = withTiming(-40, { duration: 260 }, (finished) => {
        if (finished && onDismiss) runOnJS(onDismiss)();
      });
    }, durationMs);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, message]);

  const style = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }], opacity: opacity.value }));

  if (!visible) return null;

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: 'absolute',
          top: spacing.lg,
          left: spacing.lg,
          right: spacing.lg,
          alignItems: 'center',
          zIndex: 50,
        },
        style,
      ]}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          backgroundColor: colors.bgElevated,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: toneColor[tone],
          paddingVertical: spacing.sm,
          paddingHorizontal: spacing.md,
          maxWidth: 420,
        }}
      >
        {icon && <Icon name={icon} size={16} color={toneColor[tone]} />}
        <AppText variant="labelSmall" color={colors.textPrimary} style={{ flexShrink: 1 }}>
          {message}
        </AppText>
      </View>
    </Animated.View>
  );
});
