import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { forwardRef } from 'react';
import { View } from 'react-native';
import { Canvas, Circle, Line } from '@shopify/react-native-skia';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { colors } from '@/theme';
import { AppText } from '@/components/atoms';
import { CarTurntable } from './CarTurntable';
import { CarIllustration } from './CarIllustration';
import { haptic } from '@/lib/haptics';
import { sfx } from '@/lib/sfx';
import { describeSpec, type CompoundKey, type SpokeStyle } from '@pitwall/shared/carCustomisation';
import type { Sponsorship } from '@pitwall/shared/sponsors';

/**
 * The car on its garage stage, with the upgrade sequence.
 *
 * Calling `play()` on the ref runs one repair beat: the rattle gun spins up,
 * sparks burst from the area being worked on, the bodywork blooms, and the
 * newly-fitted part is announced. Sound, haptics and visuals are driven off
 * the same clock so the flash lands on the "part seated" thunk.
 */

const SPARK_COUNT = 22;

export type UpgradeZone = 'MOTOR' | 'AERO' | 'GRIP' | 'FACTORY';

export interface CarUpgradeStageHandle {
  play: (zone: UpgradeZone, label: string) => void;
  reject: () => void;
}

interface CarUpgradeStageProps {
  motor: number;
  aero: number;
  grip: number;
  width: number;
  livery?: string;
  compound?: CompoundKey;
  rim?: string;
  spokes?: SpokeStyle;
  /** Signed sponsor deals — both modes paint them into their slots live. */
  sponsorships?: Sponsorship[];
  /**
   * '3d' shows the rotatable, real-time car; '2d' the Skia side-profile,
   * which is the one that can animate individual parts unlocking. The spark
   * burst and sound sit on top either way.
   */
  mode?: '2d' | '3d';
  /** Height for the 3D stage. Ignored in 2D, where width sets the aspect. */
  height?: number;
}

/** Where on the car each upgrade type is fitted, in 0..1 of the stage box. */
const zoneAnchor: Record<UpgradeZone, { x: number; y: number }> = {
  MOTOR: { x: 0.22, y: 0.52 },
  AERO: { x: 0.86, y: 0.66 },
  GRIP: { x: 0.30, y: 0.72 },
  FACTORY: { x: 0.50, y: 0.50 },
};

export const CarUpgradeStage = forwardRef<CarUpgradeStageHandle, CarUpgradeStageProps>(
  function CarUpgradeStage(
    { motor, aero, grip, width, livery, compound, rim, spokes, sponsorships, mode = '3d', height: heightProp },
    ref,
  ) {
    const height = mode === '3d' ? (heightProp ?? 220) : (width / 400) * 170;
    // The 3D stage swaps its sprite sheet when the spec letter changes, so a
    // tier-crossing upgrade shows the new parts on the car itself.
    const spec = describeSpec(motor, aero, grip).spec;

    // 0 → 1 across one upgrade beat; drives bloom, sparks and the banner.
    const progress = useSharedValue(0);
    const shake = useSharedValue(0);
    const denied = useSharedValue(0);
    const [zone, setZone] = useState<UpgradeZone>('MOTOR');
    const [banner, setBanner] = useState<string | null>(null);
    const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

    const clearTimers = useCallback(() => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    }, []);

    useEffect(() => () => {
      clearTimers();
      cancelAnimation(progress);
      cancelAnimation(shake);
      cancelAnimation(denied);
    }, [clearTimers, progress, shake, denied]);

    useImperativeHandle(ref, () => ({
      play: (nextZone, label) => {
        clearTimers();
        setZone(nextZone);
        setBanner(null);

        // Sound leads; it reports when the "part seated" beat lands so the
        // flash and the haptic thump can be scheduled against it.
        const fitAt = sfx.playUpgradeSequence();

        haptic.light();
        timers.current.push(setTimeout(() => haptic.medium(), 260));
        timers.current.push(
          setTimeout(() => {
            haptic.success();
            setBanner(label);
          }, fitAt),
        );
        timers.current.push(setTimeout(() => setBanner(null), fitAt + 1500));

        // Wrench rattle while the gun runs, then the bloom peaks on the thunk.
        shake.value = withSequence(
          withTiming(1, { duration: 90 }),
          withTiming(0, { duration: fitAt - 90, easing: Easing.out(Easing.ease) }),
        );
        progress.value = 0;
        progress.value = withSequence(
          withTiming(0.35, { duration: fitAt, easing: Easing.inOut(Easing.ease) }),
          withTiming(1, { duration: 520, easing: Easing.out(Easing.cubic) }),
          withTiming(0, { duration: 380, easing: Easing.in(Easing.ease) }),
        );
      },
      reject: () => {
        clearTimers();
        sfx.play('denied');
        haptic.error();
        denied.value = withSequence(
          withTiming(1, { duration: 70 }),
          withTiming(0, { duration: 260 }),
        );
      },
    }));

    const anchor = zoneAnchor[zone];
    const sparkOrigin = useMemo(
      () => ({ x: anchor.x * width, y: anchor.y * height }),
      [anchor.x, anchor.y, width, height],
    );

    // Deterministic spark directions — a fixed fan reads as a weld burst and
    // avoids re-randomising on every render.
    const sparks = useMemo(
      () =>
        Array.from({ length: SPARK_COUNT }, (_, i) => {
          const a = (Math.PI * 2 * i) / SPARK_COUNT + (i % 3) * 0.11;
          const reach = 0.55 + ((i * 37) % 100) / 160;
          return { dx: Math.cos(a) * reach, dy: Math.sin(a) * reach - 0.25 };
        }),
      [],
    );

    const stageStyle = useAnimatedStyle(() => {
      // Deterministic oscillation, not Math.random(): a worklet must be
      // reproducible, and two translateX entries in one transform array is
      // not a valid style — they have to be summed into a single offset.
      const rattle = Math.sin(shake.value * Math.PI * 14) * 1.7 * shake.value;
      return { transform: [{ translateX: rattle - denied.value * 6 }] };
    });

    // Sparks live in the second half of the beat, fading as they fly out.
    const sparkPhase = useDerivedValue(() => {
      const p = progress.value;
      return p <= 0.35 ? 0 : Math.min(1, (p - 0.35) / 0.5);
    });
    const flashOpacity = useDerivedValue(() => {
      const p = sparkPhase.value;
      return Math.sin(Math.PI * p) * 0.5;
    });

    return (
      <View style={{ width, height }} className="items-center justify-center">
        <Animated.View style={stageStyle}>
          {mode === '3d' ? (
            <CarTurntable
              width={width}
              height={height}
              spec={spec}
              livery={livery}
              compound={compound}
              rim={rim}
              sponsorships={sponsorships}
            />
          ) : (
            <CarIllustration
              motor={motor}
              aero={aero}
              grip={grip}
              width={width}
              livery={livery}
              compound={compound}
              rim={rim}
              spokes={spokes}
              sponsorships={sponsorships}
              upgradeProgress={progress}
            />
          )}
        </Animated.View>

        {/* Spark burst + work-light flash, drawn over the car */}
        <Canvas
          style={{ position: 'absolute', left: 0, top: 0, width, height }}
          pointerEvents="none"
        >
          <Circle
            cx={sparkOrigin.x}
            cy={sparkOrigin.y}
            r={width * 0.16}
            color={colors.accentLime}
            opacity={flashOpacity}
          />
          {sparks.map((s, i) => (
            <Spark
              key={i}
              origin={sparkOrigin}
              dx={s.dx}
              dy={s.dy}
              reach={width * 0.20}
              phase={sparkPhase}
              index={i}
            />
          ))}
        </Canvas>

        {banner && (
          <View
            className="absolute self-center rounded-md border border-border-active bg-deepspace/90 px-3 py-1.5"
            style={{ top: height * 0.06 }}
          >
            <AppText variant="labelSmall" color={colors.accentLime} uppercase>
              {banner}
            </AppText>
          </View>
        )}
      </View>
    );
  },
);

interface SparkProps {
  origin: { x: number; y: number };
  dx: number;
  dy: number;
  reach: number;
  phase: SharedValue<number>;
  index: number;
}

function Spark({ origin, dx, dy, reach, phase, index }: SparkProps) {
  // Each spark starts slightly after the previous one, arcs out and falls.
  const delay = (index % 5) * 0.08;
  const local = useDerivedValue(() => {
    const p = (phase.value - delay) / (1 - delay);
    return Math.min(1, Math.max(0, p));
  });

  // Plain object literals rather than Skia's vec(): calling a host function
  // that was never workletized from inside a worklet crashes the runtime.
  const start = useDerivedValue(() => ({
    x: origin.x + dx * reach * local.value * 0.55,
    y: origin.y + dy * reach * local.value * 0.55 + reach * 0.5 * local.value ** 2,
  }));
  const end = useDerivedValue(() => ({
    x: origin.x + dx * reach * local.value,
    y: origin.y + dy * reach * local.value + reach * 0.7 * local.value ** 2,
  }));
  const opacity = useDerivedValue(() => (1 - local.value) * (local.value > 0 ? 0.95 : 0));
  const color = index % 3 === 0 ? '#FFFFFF' : index % 3 === 1 ? colors.accentLime : '#E3B341';

  return <Line p1={start} p2={end} strokeWidth={2} color={color} opacity={opacity} />;
}
