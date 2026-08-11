import { PropsWithChildren, memo } from 'react';
import { Pressable, StyleProp, StyleSheet, ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { colors, gradients, glow } from '@/theme';
import { haptic } from '@/lib/haptics';
import { AppText } from './Typography';

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost';

interface GlassButtonProps {
  label: string;
  variant?: Variant;
  disabled?: boolean;
  onPress?: () => void;
  className?: string;
  style?: StyleProp<ViewStyle>;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * Blur-backed button with a spring press animation and haptic feedback.
 * Primary uses the accent gradient + blue glow.
 */
export const GlassButton = memo(function GlassButton({
  label,
  variant = 'primary',
  disabled,
  onPress,
  className,
  style,
}: PropsWithChildren<GlassButtonProps>) {
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const labelColor =
    variant === 'secondary' || variant === 'outline'
      ? colors.accentBlueLight
      : variant === 'ghost'
        ? colors.textSecondary
        : colors.textPrimary;

  return (
    <AnimatedPressable
      disabled={disabled}
      onPressIn={() => {
        scale.value = withSpring(0.96, { damping: 15, stiffness: 300 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 15, stiffness: 300 });
      }}
      onPress={() => {
        haptic.light();
        onPress?.();
      }}
      className={`h-[50px] items-center justify-center overflow-hidden rounded-md border px-6 ${
        variant === 'outline' ? 'border-border-active' : 'border-border-default'
      } ${disabled ? 'opacity-40' : ''} ${className ?? ''}`}
      style={[variant === 'primary' && glow.blue, animatedStyle, style]}
    >
      {variant === 'primary' && (
        <LinearGradient
          colors={gradients.accent}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      )}
      {(variant === 'secondary' || variant === 'ghost') && (
        <BlurView intensity={20} tint="dark" style={StyleSheet.absoluteFill} />
      )}
      <AppText variant="label" color={labelColor} uppercase>
        {label}
      </AppText>
    </AnimatedPressable>
  );
});
