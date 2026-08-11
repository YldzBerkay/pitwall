import { memo, useEffect } from 'react';
import { StyleProp, View, ViewStyle } from 'react-native';
import {
  Canvas,
  LinearGradient as SkiaGradient,
  RoundedRect,
  vec,
} from '@shopify/react-native-skia';
import {
  Easing,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { colors } from '@/theme';

interface LiquidProgressBarProps {
  /** 0..100 */
  value: number;
  height?: number;
  width?: number;
  colorFrom?: string;
  colorTo?: string;
  trackColor?: string;
  className?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * Skia-rendered progress bar with an Apple-style liquid gradient fill that
 * animates from its current width to the new value.
 */
export const LiquidProgressBar = memo(function LiquidProgressBar({
  value,
  height = 10,
  width = 220,
  colorFrom = colors.accentBlue,
  colorTo = colors.electricCyan,
  trackColor = 'rgba(255,255,255,0.06)',
  className,
  style,
}: LiquidProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, value));
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withTiming(clamped / 100, {
      duration: 900,
      easing: Easing.out(Easing.cubic),
    });
  }, [clamped, progress]);

  const fillWidth = useDerivedValue(() => Math.max(height, progress.value * width));

  return (
    <View className={className} style={[{ width, height }, style]}>
      <Canvas style={{ width, height }}>
        <RoundedRect x={0} y={0} width={width} height={height} r={height / 2} color={trackColor} />
        <RoundedRect x={0} y={0} width={fillWidth} height={height} r={height / 2}>
          <SkiaGradient start={vec(0, 0)} end={vec(width, 0)} colors={[colorFrom, colorTo]} />
        </RoundedRect>
      </Canvas>
    </View>
  );
});
