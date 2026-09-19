import { memo, useEffect, useMemo } from 'react';
import {
  Canvas,
  Circle,
  Group,
  Line,
  Oval,
  Path,
  RoundedRect,
  FillType,
  Skia,
  Text,
  matchFont,
  rect,
  vec,
} from '@shopify/react-native-skia';
import { Platform } from 'react-native';
import {
  Easing,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import {
  compoundByKey,
  describeSpec,
  liveryByKey,
  resolveRimColor,
  rimByKey,
  spokeCount,
  type CompoundKey,
  type Livery,
  type SpokeStyle,
} from '@/data/carCustomisation';

/** Perceived lightness of an "#RRGGBB", 0..1. */
function luminance(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  const channel = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => channel(c / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Ink that carries on a given paint: white on dark cars, near-black on light. */
function contrastInk(surfaceHex: string): string {
  return luminance(surfaceHex) > 0.28 ? '#0B0C0F' : '#F7F8FA';
}
import { brandByKey, slotByKey, type Sponsorship } from '@/data/sponsors';

/**
 * The team car, drawn live in Skia as a side-profile.
 *
 * This is the 2D counterpart of `tools/blender/build_f1_car.py`: the same
 * liveries, tyre compounds, rims and development spec drive both, so the
 * in-app car and the Blender showcase renders always agree. Drawing it as
 * vectors (rather than shipping sprite sheets for every combination) is what
 * lets the car change the instant a part is bought, and lets parts animate in.
 *
 * Design space is 400x170; everything scales from the given width.
 */

const VIEW_W = 400;
const VIEW_H = 170;

// Wheel centres and floor line in design space.
const REAR = { x: 96, y: 116 };
const FRONT = { x: 310, y: 116 };
const OUTLINE = '#050506';

interface CarIllustrationProps {
  motor: number;
  aero: number;
  grip: number;
  width: number;
  livery?: string;
  compound?: CompoundKey;
  rim?: string;
  spokes?: SpokeStyle;
  /** Signed deals — each one paints its brand into its slot on the bodywork. */
  sponsorships?: Sponsorship[];
  /**
   * 0 = idle. Driven 0→1 by the upgrade animation; parts that just unlocked
   * scale/fade in and the body carries a brief accent bloom.
   */
  upgradeProgress?: SharedValue<number>;
}

/**
 * Skia needs a concrete font object to lay out decal text, but `matchFont`
 * can only run once the Skia runtime is up — calling it at module scope
 * throws on web, where CanvasKit's TypefaceFontProvider does not exist yet.
 * Build it on first use instead.
 */
let cachedDecalFont: ReturnType<typeof matchFont> | null = null;

function decalFont() {
  if (!cachedDecalFont) {
    cachedDecalFont = matchFont({
      fontFamily: Platform.select({ ios: 'Helvetica', default: 'sans-serif' }),
      fontSize: 9,
      fontWeight: 'bold',
    });
  }
  return cachedDecalFont;
}

export const CarIllustration = memo(function CarIllustration({
  motor,
  aero,
  grip,
  width,
  livery = 'pitwall',
  compound = 'SOFT',
  rim = 'accent',
  spokes = 'multi',
  sponsorships,
  upgradeProgress,
}: CarIllustrationProps) {
  const paint = liveryByKey(livery);
  const tyre = compoundByKey(compound);
  const rimSpec = rimByKey(rim);
  const rimColor = resolveRimColor(rimSpec, paint);
  const spec = describeSpec(motor, aero, grip);
  const parts = spec.parts;

  const scale = width / VIEW_W;
  const height = VIEW_H * scale;

  // Idle life: a slow float, plus flicker for the exhaust flame.
  const float = useSharedValue(0);
  const flick = useSharedValue(0);
  useEffect(() => {
    float.value = withRepeat(
      withTiming(1, { duration: 2600, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    flick.value = withRepeat(withTiming(1, { duration: 170 }), -1, true);
  }, [float, flick]);

  const bodyTransform = useDerivedValue(() => [{ translateY: -2.4 * float.value }]);
  const hazeOpacity = useDerivedValue(() => 0.5 + 0.5 * flick.value);
  const hazeCoreOpacity = useDerivedValue(() => 0.35 + 0.55 * (1 - flick.value));
  const speedOpacity = useDerivedValue(() => 0.10 + 0.16 * flick.value);

  const avg = (motor + aero + grip) / 3;
  const glowOpacity = useDerivedValue(
    () => (0.07 + (avg / 100) * 0.16) * (0.82 + 0.18 * float.value),
  );

  // Bloom that sweeps the bodywork as an upgrade lands.
  const bloomOpacity = useDerivedValue(() => {
    const p = upgradeProgress?.value ?? 0;
    return Math.sin(Math.PI * Math.min(1, Math.max(0, p))) * 0.5;
  });

  // Wheel geometry widens with grip.
  const gT = spec.tiers.grip;
  const rearR = 27 + (gT - 1) * 2.6;
  const frontR = 24.5 + (gT - 1) * 2.2;

  // Body silhouette: tub holds its depth to the bulkhead, then a flat nose
  // blade runs out to a blunt tip above the front wing — as in the 3D model.
  const bodyPath = useMemo(() => {
    const p = Skia.Path.Make();
    p.moveTo(74, 104);            // rear floor edge
    p.lineTo(74, 84);
    p.cubicTo(80, 66, 104, 54, 136, 52);   // engine cover rise
    p.lineTo(186, 56);            // to the airbox shoulder
    p.lineTo(214, 66);            // cockpit surround
    p.cubicTo(238, 72, 258, 78, 276, 84);
    p.lineTo(330, 96);            // nose blade upper
    p.cubicTo(348, 100, 360, 106, 362, 114);   // tip drops onto the main plane
    p.lineTo(354, 119);
    p.cubicTo(346, 111, 330, 107, 312, 105);   // nose underside, back inboard
    p.lineTo(276, 112);
    p.lineTo(214, 108);
    p.lineTo(120, 106);
    p.close();
    return p;
  }, []);

  // Rear half of the body, for the 'split' two-tone livery. Traced from the
  // same points as bodyPath so the two always agree.
  const splitPath = useMemo(() => {
    const p = Skia.Path.Make();
    p.moveTo(74, 104);
    p.lineTo(74, 84);
    p.cubicTo(80, 66, 104, 54, 136, 52);
    p.lineTo(186, 56);
    p.lineTo(214, 66);
    p.lineTo(214, 108);
    p.lineTo(120, 106);
    p.close();
    return p;
  }, []);

  const sidepodPath = useMemo(() => {
    const p = Skia.Path.Make();
    p.moveTo(112, 106);
    p.lineTo(112, 88);
    p.cubicTo(126, 80, 160, 76, 196, 78);  // pod shoulder
    p.lineTo(214, 86);
    p.lineTo(214, 108);
    p.lineTo(112, 106);
    p.close();
    return p;
  }, []);

  return (
    <Canvas style={{ width, height }}>
      <Group transform={[{ scale }]}>
        {/* Ground bloom + contact shadow */}
        <Oval rect={rect(40, 138, 330, 17)} color={paint.primary} opacity={glowOpacity} />
        <Oval rect={rect(62, 143, 288, 10)} color="#000000" opacity={0.5} />

        <Group transform={bodyTransform}>
          {/* MOTOR T3 — speed lines trailing the car */}
          {parts.heatHaze && (
            <Group opacity={speedOpacity}>
              <RoundedRect x={4} y={66} width={40} height={3} r={2} color={paint.primary} />
              <RoundedRect x={12} y={88} width={32} height={3} r={2} color={paint.primary} />
              <RoundedRect x={4} y={108} width={40} height={3} r={2} color={paint.primary} />
            </Group>
          )}

          {/* ── Rear wing ── */}
          <RoundedRect
            x={24}
            y={parts.rearDrsOpen ? 40 : parts.rearFlap ? 44 : 52}
            width={9}
            height={parts.rearDrsOpen ? 66 : parts.rearFlap ? 60 : 50}
            r={3}
            color={parts.endplateLips ? paint.accent : paint.trim}
          />
          <RoundedRect x={28} y={68} width={58} height={7} r={3} color={paint.trim} />
          {parts.rearFlap && !parts.rearDrsOpen && (
            <RoundedRect x={28} y={57} width={56} height={6} r={3} color={paint.trim} />
          )}
          {parts.rearDrsOpen && (
            /* 2026 active aero: the flap drops into its flat low-drag
               X-mode — the visual reward for a top-spec wing */
            <Path
              path="M 28 48 L 86 40 L 86 46 L 28 55 Z"
              color={paint.trim}
            />
          )}
          <RoundedRect x={64} y={74} width={5} height={20} r={2} color={paint.trim} />

          {/* AERO T3 — T-wing + shark fin */}
          {parts.tWing && (
            <RoundedRect x={92} y={62} width={26} height={5} r={2} color={paint.trim} />
          )}
          {parts.sharkFin && (
            <>
              <Path
                path="M 104 74 L 104 46 L 158 56 L 158 74 Z"
                color={paint.secondary}
              />
              <Path
                path="M 104 46 L 158 56"
                style="stroke"
                strokeWidth={2.5}
                color={paint.accent}
              />
            </>
          )}

          {/* MOTOR — exhaust + heat haze */}
          {parts.exhaust && (
            <>
              <RoundedRect
                x={64}
                y={parts.exhaustLarge ? 78 : 80}
                width={22}
                height={parts.exhaustLarge ? 11 : 8}
                r={4}
                color={rimColor}
              />
              <Circle cx={67} cy={parts.exhaustLarge ? 83.5 : 84} r={3} color={OUTLINE} />
            </>
          )}
          {parts.heatHaze && (
            <>
              <Oval rect={rect(30, 78, 34, 12)} color="#E3B341" opacity={hazeOpacity} />
              <Oval rect={rect(18, 80, 22, 8)} color={paint.primary} opacity={hazeCoreOpacity} />
            </>
          )}

          {/* ── Floor, diffuser ── */}
          <RoundedRect x={68} y={106} width={272} height={9} r={3} color={paint.trim} />
          {parts.diffuserStrakes && (
            <>
              <Path path="M 60 115 L 92 100 L 92 115 Z" color={paint.trim} />
              {[68, 76, 84].map((x) => (
                <Line
                  key={x}
                  p1={vec(x, 114)}
                  p2={vec(x + 6, 103)}
                  strokeWidth={2}
                  color={paint.primary}
                  opacity={0.55}
                />
              ))}
            </>
          )}

          {/* ── Bodywork ── */}
          <Path path={bodyPath} color={paint.primary} />
          <Path path={bodyPath} style="stroke" strokeWidth={2} color={OUTLINE} />
          {paint.style === 'split' && (
            <>
              <Path path={splitPath} color={paint.secondary} />
              <Path path={splitPath} style="stroke" strokeWidth={1.6} color={OUTLINE} />
              <Path path="M 209 64 L 219 67 L 219 108 L 209 108 Z" color={paint.accent} />
            </>
          )}
          <Path path={sidepodPath} color={paint.secondary} />
          <Path path={sidepodPath} style="stroke" strokeWidth={1.6} color={OUTLINE} />

          {/* Livery marks */}
          {(paint.style === 'stripe' || paint.style === 'flash') && (
            <RoundedRect x={120} y={92} width={92} height={4} r={2} color={paint.accent} />
          )}
          {paint.style === 'flash' && (
            <Path
              path="M 226 76 L 344 98 L 344 102 L 226 82 Z"
              color={paint.accent}
            />
          )}

          {/* Airbox + engine louvres */}
          <RoundedRect x={168} y={48} width={18} height={11} r={4} color={paint.trim} />
          {parts.engineLouvres &&
            [118, 132, 146, 160].map((x) => (
              <RoundedRect key={x} x={x} y={58} width={9} height={3} r={1.5} color={paint.trim} />
            ))}

          {/* MOTOR T2 — 2026 battery cooling duct along the pod shoulder */}
          {parts.energyPods && (
            <RoundedRect x={132} y={79} width={62} height={5} r={2.5} color={paint.accent} />
          )}

          {/* Cockpit, driver, halo */}
          <RoundedRect x={196} y={60} width={46} height={20} r={8} color={paint.trim} />
          <Circle cx={220} cy={62} r={10} color={paint.accent} />
          <Circle cx={220} cy={62} r={10} style="stroke" strokeWidth={1.5} color={OUTLINE} />
          <RoundedRect x={220} y={58} width={9} height={5} r={2} color={paint.trim} />
          <Path
            path="M 194 64 Q 220 42 248 60"
            style="stroke"
            strokeWidth={4}
            color={paint.trim}
          />
          <Line p1={vec(232, 50)} p2={vec(238, 64)} strokeWidth={3} color={paint.trim} />

          {/* Bargeboard */}
          {parts.bargeboards && (
            <Path path="M 226 106 L 238 90 L 250 90 L 240 106 Z" color={paint.trim} />
          )}

          {/* ── Front wing ──
              Every element sits ahead of the front tyre, which reaches
              x≈339 at GRIP T3 — the stack used to start at 318 and grow
              straight out of the wheel, the same defect the 3D model had. */}
          <RoundedRect x={346} y={120} width={44} height={6} r={2} color={paint.trim} />
          {parts.frontFlap2 && (
            <RoundedRect x={344} y={113} width={38} height={5} r={2} color={paint.trim} />
          )}
          {parts.frontFlap3 && (
            <RoundedRect x={343} y={106} width={32} height={4} r={2} color={paint.trim} />
          )}
          <RoundedRect
            x={384}
            y={parts.frontFlap3 ? 102 : 112}
            width={7}
            height={parts.frontFlap3 ? 26 : 16}
            r={2}
            color={parts.endplateLips ? paint.accent : paint.trim}
          />
          <Circle cx={300} cy={100} r={5} color={paint.accent} />


          {/* Suspension */}
          <Line p1={vec(290, 92)} p2={vec(308, 112)} strokeWidth={3} color={paint.trim} />
          <Line p1={vec(290, 102)} p2={vec(308, 114)} strokeWidth={3} color={paint.trim} />
          <Line p1={vec(114, 92)} p2={vec(97, 112)} strokeWidth={3} color={paint.trim} />
          <Line p1={vec(114, 102)} p2={vec(97, 114)} strokeWidth={3} color={paint.trim} />

          {/* ── Wheels ── */}
          <Wheel
            c={REAR}
            r={rearR}
            band={tyre.band}
            grooved={tyre.grooved}
            rimColor={rimColor}
            spokes={spokes}
            upgraded={parts.rimUpgrade}
            accent={paint.accent}
          />
          <Wheel
            c={FRONT}
            r={frontR}
            band={tyre.band}
            grooved={tyre.grooved}
            rimColor={rimColor}
            spokes={spokes}
            upgraded={parts.rimUpgrade}
            accent={paint.accent}
          />

          {/* Sponsor decals, each in the slot its contract bought */}
          {sponsorships?.map((deal) => (
            <SponsorDecal key={deal.slot} deal={deal} paint={paint} />
          ))}

          {/* Upgrade bloom over the bodywork */}
          <Path path={bodyPath} color={paint.accent} opacity={bloomOpacity} />
        </Group>
      </Group>
    </Canvas>
  );
});

/**
 * One sponsor's branding, painted into its slot.
 *
 * Same lockup rules as the 3D car's decal textures (`CarTurntable`'s
 * `paintDecalPng`): the mark rides beside the wordmark when the slot is wide
 * enough to hold both, and the wordmark takes the whole plate when it is not.
 * At this scale a slot is 15 design units tall, so anything that does not fit
 * has to be dropped rather than shrunk into mush.
 */
function SponsorDecal({ deal, paint }: { deal: Sponsorship; paint: Livery }) {
  const brand = brandByKey(deal.brandKey);
  const slot = slotByKey(deal.slot);
  const markPath = useMemo(() => {
    if (!brand?.logo.mark) return null;
    const path = Skia.Path.MakeFromSVGString(brand.logo.mark);
    path?.setFillType(brand.logo.evenOdd ? FillType.EvenOdd : FillType.Winding);
    return path;
  }, [brand]);
  if (!brand) return null;

  const { x, y, w, h } = slot.decal;
  const { logo } = brand;
  // A plateless brand prints onto the paint, so it cannot use its own ink —
  // a near-black wordmark on a midnight car is an invisible ad.
  // Shapes the 2D car can tell apart at 15 design units tall: a rounded rect,
  // a pill, and a circular badge. A hexagon at this size is a blob, so it is
  // drawn as a rect here and only reads as a hexagon on the 3D car.
  const plated = logo.plate !== false;
  const badge = plated && logo.shape === 'round';
  const pill = plated && logo.shape === 'pill';
  const surface = slot.key === 'halo' || slot.key === 'floorEdge' ? paint.trim : paint.primary;
  const ink = plated ? logo.ink : contrastInk(surface);
  const wordInk = !plated || logo.shape === 'round' ? contrastInk(surface) : logo.ink;
  const pad = Math.min(w, h) * 0.14;
  const markBox = (h - pad * 2) * 0.95;
  const label = logo.word ?? brand.short;
  // ~5.2px per bold 9px glyph — the font is fixed at 9px here, so this only
  // decides whether the label fits, not how big to draw it.
  const textWidth = label.length * 5.2;
  const withMark = markPath != null && (badge || w - markBox - pad * 3 >= textWidth);
  const textX = withMark
    ? x + pad + markBox + pad
    : x + Math.max(1.5, (w - textWidth) / 2);

  return (
    <Group>
      {plated && !badge && (
        <>
          <RoundedRect
            x={x}
            y={y}
            width={w}
            height={h}
            r={pill ? h / 2 : 2.5}
            color={logo.bg ?? brand.color}
          />
          <RoundedRect
            x={x}
            y={y}
            width={w}
            height={h}
            r={pill ? h / 2 : 2.5}
            style="stroke"
            strokeWidth={1}
            color={OUTLINE}
          />
        </>
      )}
      {badge && (
        <Circle
          cx={x + pad + markBox / 2}
          cy={y + h / 2}
          r={markBox / 2 + pad * 0.5}
          color={logo.bg ?? brand.color}
        />
      )}
      {withMark && markPath && (
        <Group
          transform={[
            { translateX: x + pad },
            { translateY: y + (h - markBox) / 2 },
            { scale: markBox / 100 },
          ]}
        >
          <Path
            path={markPath}
            color={ink}
            style={logo.stroke ? 'stroke' : 'fill'}
            strokeWidth={logo.stroke ?? 0}
            strokeCap="round"
            strokeJoin="round"
          />
        </Group>
      )}
      {textWidth <= w - 3 && (
        <Text x={textX} y={y + h / 2 + 3.2} text={label} font={decalFont()} color={wordInk} />
      )}
    </Group>
  );
}

interface WheelProps {
  c: { x: number; y: number };
  r: number;
  band: string;
  grooved: boolean;
  rimColor: string;
  spokes: SpokeStyle;
  upgraded: boolean;
  accent: string;
}

function Wheel({ c, r, band, grooved, rimColor, spokes, upgraded, accent }: WheelProps) {
  const count = spokeCount(spokes);
  const rimR = r * 0.635;

  const spokeLines = useMemo(() => {
    const lines: { x1: number; y1: number; x2: number; y2: number }[] = [];
    for (let i = 0; i < count; i += 1) {
      const a = (Math.PI * i) / count;
      const dx = Math.cos(a) * rimR * 0.92;
      const dy = Math.sin(a) * rimR * 0.92;
      lines.push({ x1: c.x - dx, y1: c.y - dy, x2: c.x + dx, y2: c.y + dy });
    }
    return lines;
  }, [c.x, c.y, count, rimR]);

  const treadBlocks = useMemo(() => {
    if (!grooved) return [];
    const blocks: { x: number; y: number; a: number }[] = [];
    for (let i = 0; i < 12; i += 1) {
      const a = (2 * Math.PI * i) / 12;
      blocks.push({
        x: c.x + Math.sin(a) * r * 0.93,
        y: c.y + Math.cos(a) * r * 0.93,
        a,
      });
    }
    return blocks;
  }, [c.x, c.y, r, grooved]);

  return (
    <>
      {/* Tyre carcass */}
      <Circle cx={c.x} cy={c.y} r={r} color="#141518" />
      <Circle cx={c.x} cy={c.y} r={r} style="stroke" strokeWidth={2.5} color={OUTLINE} />

      {/* Intermediates / wets show tread blocks */}
      {treadBlocks.map((b, i) => (
        <Circle key={i} cx={b.x} cy={b.y} r={r * 0.09} color="#1F2126" />
      ))}

      {/* Compound sidewall band — the F1 tell */}
      <Circle
        cx={c.x}
        cy={c.y}
        r={r * 0.80}
        style="stroke"
        strokeWidth={r * 0.13}
        color={band}
      />

      {/* Rim: dark barrel, spoke star, polished lip, centre lock */}
      <Circle cx={c.x} cy={c.y} r={rimR} color="#0E0F12" />
      {spokeLines.map((l, i) => (
        <Line
          key={i}
          p1={vec(l.x1, l.y1)}
          p2={vec(l.x2, l.y2)}
          strokeWidth={count <= 5 ? 3.4 : count <= 10 ? 2.2 : 1.5}
          color={rimColor}
        />
      ))}
      <Circle cx={c.x} cy={c.y} r={rimR} style="stroke" strokeWidth={2.4} color={rimColor} />
      <Circle cx={c.x} cy={c.y} r={r * 0.13} color={upgraded ? accent : '#1F2126'} />
    </>
  );
}
