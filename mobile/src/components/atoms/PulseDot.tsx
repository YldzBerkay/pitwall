import { memo, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { colors } from '@/theme';

interface PulseDotProps {
  color?: string;
  size?: number;
  /** Pulse period in ms. Pass a smaller value as the countdown nears zero. */
  periodMs?: number;
}

/**
 * Animated dot with an expanding halo. Speeds up as `periodMs` decreases,
 * matching the "second-by-second pulse" of the race countdown.
 */
export const PulseDot = memo(function PulseDot({
  color = colors.electricCyan,
  size = 10,
  periodMs = 1400,
}: PulseDotProps) {
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = 0;
    progress.value = withRepeat(
      withTiming(1, { duration: periodMs, easing: Easing.out(Easing.ease) }),
      -1,
      false,
    );
    return () => cancelAnimation(progress);
  }, [periodMs, progress]);

  const haloStyle = useAnimatedStyle(() => ({
    opacity: 1 - progress.value,
    transform: [{ scale: 1 + progress.value * 2.5 }],
  }));

  return (
    <View style={[styles.container, { width: size * 3, height: size * 3 }]}>
      <Animated.View
        style={[
          styles.halo,
          { width: size, height: size, borderRadius: size / 2, backgroundColor: color },
          haloStyle,
        ]}
      />
      <View
        style={[styles.core, { width: size, height: size, borderRadius: size / 2, backgroundColor: color }]}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  halo: {
    position: 'absolute',
  },
  core: {},
});
