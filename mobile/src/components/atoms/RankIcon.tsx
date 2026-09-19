import { memo, useMemo } from 'react';
import { Canvas, Path, Skia } from '@shopify/react-native-skia';
import { colors } from '@/theme';

/**
 * Rank badges, drawn rather than shipped as images: ten original line marks on
 * a 24-unit grid, one stroke weight, the rank's colour. Nothing here echoes a
 * real logo — they are abstract shapes that read as a ladder from a plain
 * garage door to a laurel.
 */
const MARKS: Record<number, string> = {
  // 1 Paddock: a garage door
  1: 'M4 20 V9 L12 4 L20 9 V20 M8 20 V12 H16 V20 M8 15 H16',
  // 2 Rookie: a single chevron
  2: 'M5 16 L12 8 L19 16',
  // 3 Grid: a grid box
  3: 'M5 5 H19 V19 H5 Z M12 5 V19 M5 12 H19',
  // 4 Apex: a corner apex line
  4: 'M4 19 C8 8, 16 8, 20 19 M12 10 V13',
  // 5 Podium: three steps
  5: 'M3 20 H21 M6 20 V14 H10 V20 M10 14 V8 H14 V20 M14 20 V11 H18 V20',
  // 6 Pole: a flag pole with pennant
  6: 'M7 21 V3 M7 4 L18 7 L7 10',
  // 7 Maestro: a baton arc with a star point
  7: 'M4 18 C8 6, 16 6, 20 18 M12 4 V7 M12 9 L13 11 L15 11 L13.5 12.5 L14 15 L12 13.5 L10 15 L10.5 12.5 L9 11 L11 11 Z',
  // 8 Titan: a shield
  8: 'M12 3 L20 6 V12 C20 17, 16 20, 12 21 C8 20, 4 17, 4 12 V6 Z M12 8 V16',
  // 9 Legend: a laurel pair
  9: 'M12 20 C6 20, 4 14, 5 8 C9 9, 12 13, 12 20 Z M12 20 C18 20, 20 14, 19 8 C15 9, 12 13, 12 20 Z',
  // 10 Grand Slam: a crown of four points
  10: 'M4 18 H20 M4 18 L3 8 L8 12 L12 5 L16 12 L21 8 L20 18',
};

interface RankIconProps {
  level: number;
  colour?: string;
  size?: number;
}

export const RankIcon = memo(function RankIcon({ level, colour = colors.accentLime, size = 32 }: RankIconProps) {
  const path = useMemo(() => Skia.Path.MakeFromSVGString(MARKS[level] ?? MARKS[1]) ?? Skia.Path.Make(), [level]);
  const scale = size / 24;
  return (
    <Canvas style={{ width: size, height: size }}>
      <Path
        path={path}
        style="stroke"
        strokeWidth={1.8 / scale}
        strokeCap="round"
        strokeJoin="round"
        color={colour}
        transform={[{ scale }]}
      />
    </Canvas>
  );
});
