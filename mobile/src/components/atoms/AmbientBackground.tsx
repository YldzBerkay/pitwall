import { memo, useEffect } from 'react';
import { StyleSheet, useWindowDimensions } from 'react-native';
import { Canvas, Circle, Blur, Group } from '@shopify/react-native-skia';
import {
  Easing,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { colors } from '@/theme';

/**
 * Slow-moving ambient "mesh gradient" backdrop. Two heavily-blurred blobs
 * drift behind everything to keep deep-space screens from feeling flat/black.
 */
export const AmbientBackground = memo(function AmbientBackground() {
  const { width, height } = useWindowDimensions();
  const t = useSharedValue(0);

  useEffect(() => {
    t.value = withRepeat(withTiming(1, { duration: 16000, easing: Easing.inOut(Easing.ease) }), -1, true);
  }, [t]);

  const blueX = useDerivedValue(() => width * (0.25 + t.value * 0.2));
  const blueY = useDerivedValue(() => height * (0.18 + t.value * 0.12));
  const purpleX = useDerivedValue(() => width * (0.8 - t.value * 0.2));
  const purpleY = useDerivedValue(() => height * (0.72 - t.value * 0.1));

  return (
    <Canvas style={[StyleSheet.absoluteFill, { backgroundColor: colors.bgDeepSpace }]}>
      <Group>
        <Blur blur={90} />
        <Circle cx={blueX} cy={blueY} r={width * 0.5} color="#16205544" />
        <Circle cx={purpleX} cy={purpleY} r={width * 0.45} color="#2A163F44" />
      </Group>
    </Canvas>
  );
});
