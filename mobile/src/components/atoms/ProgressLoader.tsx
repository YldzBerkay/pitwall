import { memo, useEffect, useState } from 'react';
import { View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { colors, radius, spacing } from '@/theme';
import { AppText } from './Typography';

interface ProgressLoaderProps {
  /** 0..100 — must reflect real load progress, never a decoy animation. */
  value: number;
  /** Rotates every ~2.2s while loading; keeps a long wait from feeling dead. */
  tips?: string[];
  label?: string;
}

/**
 * A real, always-advancing progress bar for waits that can exceed ~1s
 * (font/asset loading, session join). Never used for waits under ~1s — for
 * those, screens should show nothing rather than a flash of this component.
 */
export const ProgressLoader = memo(function ProgressLoader({ value, tips, label = 'Yükleniyor' }: ProgressLoaderProps) {
  const width = useSharedValue(0);
  const clamped = Math.max(0, Math.min(100, value));
  const [tipIdx, setTipIdx] = useState(0);

  useEffect(() => {
    width.value = withTiming(clamped, { duration: 400, easing: Easing.out(Easing.cubic) });
  }, [clamped, width]);

  useEffect(() => {
    if (!tips || tips.length < 2) return;
    const id = setInterval(() => setTipIdx((i) => (i + 1) % tips.length), 2200);
    return () => clearInterval(id);
  }, [tips]);

  const fillStyle = useAnimatedStyle(() => ({ width: `${width.value}%` }));

  return (
    <View style={{ width: '100%', maxWidth: 320, gap: spacing.md, alignItems: 'center' }}>
      <AppText variant="labelSmall" color={colors.textSecondary} uppercase>
        {label} · %{Math.round(clamped)}
      </AppText>
      <View
        style={{
          width: '100%',
          height: 6,
          borderRadius: radius.pill,
          backgroundColor: 'rgba(255,255,255,0.08)',
          overflow: 'hidden',
        }}
      >
        <Animated.View style={[{ height: '100%', borderRadius: radius.pill, backgroundColor: colors.accentLime }, fillStyle]} />
      </View>
      {tips && tips.length > 0 && (
        <AppText variant="bodySmall" color={colors.textTertiary} style={{ textAlign: 'center' }} numberOfLines={2}>
          {tips[tipIdx % tips.length]}
        </AppText>
      )}
    </View>
  );
});
