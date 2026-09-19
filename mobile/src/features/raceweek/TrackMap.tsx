import { memo, useMemo } from 'react';
import { View } from 'react-native';
import { Canvas, Circle, Group, Path, Skia } from '@shopify/react-native-skia';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';
import { colors } from '@/theme';
import { teamByKey } from '@/data/teams';
import { pointAlong, type Point, type Track } from '@/data/tracks';
import type { CarState, RaceState } from '@/data/raceEngine';

/**
 * The circuit as a line and the twenty-two cars as dots on it.
 *
 * Positions are read off race time: the leader has covered `lap` laps, every
 * other car a little less by its gap. Between two laps the dots are
 * interpolated with `progress` (0 → 1 over one game tick) on the UI thread,
 * so the picture moves even though the engine only speaks once per lap.
 */
interface TrackMapProps {
  track: Track;
  race?: RaceState;
  /** The state one lap earlier, for interpolation. */
  prev?: RaceState;
  progress: SharedValue<number>;
  width: number;
  height: number;
}

const PAD = 18;

/** Same curve as `pointAlong`, written as a worklet so the UI thread can run it. */
function pointAlongW(layout: Point[], progress: number): Point {
  'worklet';
  const n = layout.length;
  const u = ((progress % 1) + 1) % 1;
  const scaled = u * n;
  const i = Math.floor(scaled);
  const s = scaled - i;
  const p0 = layout[(i - 1 + n) % n];
  const p1 = layout[i % n];
  const p2 = layout[(i + 1) % n];
  const p3 = layout[(i + 2) % n];
  const cr = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (-a + c) * s + (2 * a - 5 * b + 4 * c - d) * s * s + (-a + 3 * b - 3 * c + d) * s * s * s);
  return { x: cr(p0.x, p1.x, p2.x, p3.x), y: cr(p0.y, p1.y, p2.y, p3.y) };
}

/** Laps covered by a car at the end of the state's lap, leader = whole laps. */
function covered(car: CarState, state: RaceState, lapRef: number): number {
  const leader = state.cars.find((c) => !c.dnf) ?? state.cars[0];
  return state.lap - Math.max(0, car.totalSec - leader.totalSec) / lapRef;
}

export const TrackMap = memo(function TrackMap({ track, race, prev, progress, width, height }: TrackMapProps) {
  const w = Math.max(0, width - PAD * 2);
  const h = Math.max(0, height - PAD * 2);
  const scale = { x: w, y: h };

  const path = useMemo(() => {
    const b = Skia.PathBuilder.Make();
    const steps = 240;
    for (let i = 0; i <= steps; i++) {
      const pt = pointAlong(track.layout, i / steps);
      const x = PAD + pt.x * scale.x;
      const y = PAD + pt.y * scale.y;
      if (i === 0) b.moveTo(x, y);
      else b.lineTo(x, y);
    }
    b.close();
    return b.detach();
  }, [track, scale.x, scale.y]);

  const start = pointAlong(track.layout, 0);
  const startNext = pointAlong(track.layout, 0.01);
  // A short bar across the line at the start.
  const dx = startNext.x - start.x;
  const dy = startNext.y - start.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * 7;
  const ny = (dx / len) * 7;
  const sx = PAD + start.x * scale.x;
  const sy = PAD + start.y * scale.y;

  const lapRef = track.baseLapSec + 5;

  return (
    <View style={{ width, height }}>
      <Canvas style={{ width, height }}>
        <Path path={path} style="stroke" strokeWidth={9} color={colors.bgSurface2} strokeJoin="round" />
        <Path path={path} style="stroke" strokeWidth={3} color="rgba(255,255,255,0.22)" strokeJoin="round" />
        <Path
          path={`M ${sx + nx} ${sy + ny} L ${sx - nx} ${sy - ny}`}
          style="stroke"
          strokeWidth={3}
          color={colors.accentLime}
        />
        {race &&
          [...race.cars]
            // Draw the player's cars last so they sit on top.
            .sort((a, b) => Number(a.isPlayer) - Number(b.isPlayer))
            .map((car) => {
              if (car.dnf) return null;
              const prevCar = prev?.cars.find((c) => c.teamKey === car.teamKey && c.driverIdx === car.driverIdx);
              const from = prev && prevCar && !prevCar.dnf ? covered(prevCar, prev, lapRef) : covered(car, race, lapRef) - 1;
              const to = covered(car, race, lapRef);
              return (
                <CarDot
                  key={`${car.teamKey}-${car.driverIdx}`}
                  layout={track.layout}
                  from={from}
                  to={to}
                  progress={progress}
                  scale={scale}
                  colour={teamByKey(car.teamKey).colour}
                  highlight={car.isPlayer}
                  pitting={car.pitting}
                />
              );
            })}
      </Canvas>
    </View>
  );
});

interface CarDotProps {
  layout: Point[];
  from: number;
  to: number;
  progress: SharedValue<number>;
  scale: { x: number; y: number };
  colour: string;
  highlight: boolean;
  pitting: boolean;
}

function CarDot({ layout, from, to, progress, scale, colour, highlight, pitting }: CarDotProps) {
  const cx = useDerivedValue(() => {
    const laps = from + (to - from) * progress.value;
    return PAD + pointAlongW(layout, laps).x * scale.x;
  });
  const cy = useDerivedValue(() => {
    const laps = from + (to - from) * progress.value;
    return PAD + pointAlongW(layout, laps).y * scale.y;
  });
  return (
    <Group opacity={pitting ? 0.45 : 1}>
      {highlight && <Circle cx={cx} cy={cy} r={9} color="rgba(212,255,61,0.28)" />}
      <Circle cx={cx} cy={cy} r={highlight ? 5.5 : 4} color={colour} />
      {highlight && <Circle cx={cx} cy={cy} r={2} color={colors.bgDeepSpace} />}
    </Group>
  );
}
