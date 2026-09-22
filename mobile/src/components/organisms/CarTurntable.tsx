import { useEffect, useMemo, useRef } from 'react';
import { Platform, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Easing, useSharedValue, useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { FillType, ImageFormat, PaintStyle, Skia, TileMode, matchFont } from '@shopify/react-native-skia';
import { File, Paths } from 'expo-file-system';
import {
  Camera,
  DefaultLight,
  EntitySelector,
  FilamentScene,
  FilamentView,
  Model,
  useBuffer,
  useCameraManipulator,
} from 'react-native-filament';
import { colors } from '@/theme';
import { AppText } from '@/components/atoms';
import {
  compoundByKey,
  liveryByKey,
  rimByKey,
  resolveRimColor,
  type CompoundKey,
  type SpecLetter,
} from '@pitwall/shared/carCustomisation';
import {
  brandByKey,
  slotByKey,
  type Brand,
  type LogoFont,
  type SlotKey,
  type Sponsorship,
} from '@pitwall/shared/sponsors';

/**
 * The team's 3D car, rendered live and turned by dragging.
 *
 * This is a real-time scene — react-native-filament binds Google's Filament
 * engine over JSI (Metal on iOS, Vulkan/GLES on Android), rendering on its
 * own thread. That replaces the previous approach, which dragged a sprite
 * sheet of 24 pre-rendered Blender stills: this car turns continuously, at
 * any angle, and its paint recolours instantly instead of only ever showing
 * the handful of liveries that were baked into a sheet.
 *
 * The models are per-spec `.glb` exports of `tools/blender/build_toon_car.py`
 * (see `tools/blender/export_glb.sh`), one each for development spec C / B / A
 * — the same tier system as before, now real geometry instead of a swapped
 * image. Livery, tyre compound and rim colour are NOT baked in: the builder's
 * `join_by_material()` step names each merged mesh after its material (see
 * `build_f1_car.py::export_glb`), so `PW_Primary`, `PW_Accent`,
 * `PW_CompoundBand`, `PW_Rim`, etc. are both the glTF node name and its one
 * material — `<EntitySelector byName="PW_Primary" materialParameters={...}>`
 * finds that mesh and repaints it on the render thread every time the catalog
 * selection changes.
 *
 * Sponsor branding rides a second mechanism. `tools/blender/build_toon_car.py`
 * bakes eight flat, UV-mapped plates onto the body — `PW_Decal_sidepod`,
 * `PW_Decal_nose`, etc. — named after the exact `SlotKey`s in `@pitwall/shared/sponsors`,
 * sitting there in every spec regardless of whether the aero part they're near
 * actually exists yet (a sponsor deal isn't gated by development tier).
 *
 * Every slot is repainted on every render, sold or not — an EMPTY slot is
 * NOT left at some placeholder tone; it's recoloured to match the bodywork
 * (or, for the halo/floor-edge plates, the carbon trim) it sits on, via
 * `SPONSOR_SURFACE` below, so an unsold plate reads as bare car rather than
 * a grey sticker with nothing on it — the plate is only ever visible once a
 * brand owns it. A SIGNED `Sponsorship` gets its own small PNG instead — the
 * brand's colour, a soft diagonal sheen, a dark inset border, its short name
 * — painted once with Skia's offscreen canvas (the same look the 2D
 * `CarIllustration`'s `SponsorDecal` draws, plus the sheen), written to a
 * cache file, and swapped onto the plate's material with
 * `<EntitySelector textureMap={...}>`. A `data:` URI would be simpler but
 * react-native-filament's loader only understands `http(s)://`, `file://`,
 * or a bundled resource — hence the write-to-cache step.
 *
 * Two things this trades away from the sprite-sheet version:
 *  - The ink outline. It was baked as a second material slot on the same
 *    mesh (an inverted-hull Solidify modifier), and glTF splits a mesh with
 *    two material slots into two primitives in an order the loader doesn't
 *    guarantee — recolouring `getMaterialInstanceAt(entity, 0)` could hit the
 *    outline instead of the paint. The exported models drop it
 *    (`--no-outline`) so every material index is predictable. The toy
 *    proportions, glossy clear-coat and punchy rim light still carry the
 *    cartoon read; a fresnel-based outline shader is a possible follow-up.
 *  - Rim metallic/roughness per finish. The app's `Rim` catalog only carries
 *    a colour (`car_config.py`'s `RIMS` table also has per-finish metallic/
 *    roughness, which never made it into the TS mirror) — so only
 *    `PW_Rim`'s colour is live; its sheen stays whatever the export baked.
 */

const MODELS: Record<SpecLetter, number> = {
  C: require('../../../assets/car/f1-car-C.glb'),
  B: require('../../../assets/car/f1-car-B.glb'),
  A: require('../../../assets/car/f1-car-A.glb'),
};

/**
 * Which `PW_*` materials exist in a given spec's export, and are safe to
 * recolour. `<EntitySelector>` throws if asked for a node that isn't in the
 * model, so this list must stay in sync with what `export_glb.sh` actually
 * bakes — re-run `python3 -c "..."` over the .glb (see that script's header)
 * after changing which parts exist per tier.
 *
 * Since the 2026 rebuild every spec carries the same recolourable set:
 * `PW_CarbonLight` used to appear only from spec B up, but the rear
 * driveshafts are moulded from it and every car has those.
 */
const RECOLOR_BASE = [
  'PW_Primary', 'PW_Secondary', 'PW_Accent', 'PW_Carbon', 'PW_CarbonLight',
  'PW_CompoundBand', 'PW_Rim',
] as const;

const RECOLOR_TARGETS: Record<SpecLetter, readonly string[]> = {
  C: RECOLOR_BASE,
  B: RECOLOR_BASE,
  A: RECOLOR_BASE,
};

/**
 * sRGB (0–1) → linear (0–1), same curve as `build_f1_car.py::srgb_to_linear`.
 * The glTF/Filament base colour parameter is linear; feeding it sRGB floats
 * straight (the mistake the Blender side already made once) washes every
 * livery out toward pastel.
 */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Perceived lightness of an "#RRGGBB", 0..1. */
function luminance(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** Ink that carries on a given paint: white on dark cars, near-black on light. */
function contrastInk(surfaceHex: string): string {
  return luminance(surfaceHex) > 0.28 ? '#0B0C0F' : '#F7F8FA';
}

/**
 * The colour the bodywork under a slot is painted — the livery's trim for the
 * carbon slots, and its second tone for the two-tone styles, which put the
 * cover, pods and rear wing in that tone.
 */
function surfaceHexFor(slot: SlotKey, livery: ReturnType<typeof liveryByKey>): string {
  if (SPONSOR_SURFACE[slot] === 'carbon') return livery.trim;
  const twoTone = livery.style === 'duotone' || livery.style === 'split';
  return twoTone ? livery.secondary : livery.primary;
}

/** "#RRGGBB" → linear [r, g, b, a], scaled by `gain` in sRGB space first. */
function hexToLinearRGBA(hex: string, gain = 1): [number, number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const clampedGain = (c: number) => Math.min(1, c * gain);
  return [srgbToLinear(clampedGain(r)), srgbToLinear(clampedGain(g)), srgbToLinear(clampedGain(b)), 1];
}

function colorForTarget(
  name: string,
  livery: ReturnType<typeof liveryByKey>,
  compound: ReturnType<typeof compoundByKey>,
  rimColorHex: string,
): [number, number, number, number] {
  switch (name) {
    case 'PW_Primary':
      return hexToLinearRGBA(livery.primary);
    case 'PW_Secondary':
      return hexToLinearRGBA(livery.secondary);
    case 'PW_Accent':
      return hexToLinearRGBA(livery.accent);
    case 'PW_Carbon':
      return hexToLinearRGBA(livery.trim);
    // Matches build_materials(): carbon_light is the trim colour lifted 1.75x.
    case 'PW_CarbonLight':
      return hexToLinearRGBA(livery.trim, 1.75);
    case 'PW_CompoundBand':
      return hexToLinearRGBA(compound.band);
    case 'PW_Rim':
      return hexToLinearRGBA(rimColorHex);
    default:
      return [1, 1, 1, 1];
  }
}

// ── Sponsor decal textures ──────────────────────────────────────────────────

const DECAL_TEX_LONG = 512;

/** The four families both platforms actually ship. A family that is not
 * installed falls back silently, and the brand loses its voice. */
const FONT_FAMILY: Record<LogoFont, string> = {
  sans: Platform.select({ ios: 'Helvetica', default: 'sans-serif' })!,
  serif: Platform.select({ ios: 'Georgia', default: 'serif' })!,
  mono: Platform.select({ ios: 'Courier New', default: 'monospace' })!,
  condensed: Platform.select({ ios: 'Avenir Next Condensed', default: 'sans-serif-condensed' })!,
};

/** A brand's wordmark font at an exact pixel size. `matchFont` has to run
 * after the Skia runtime is up, which isn't true at module-evaluation time. */
function decalFont(size: number, logo?: Brand['logo']) {
  return matchFont({
    fontFamily: FONT_FAMILY[logo?.font ?? 'sans'],
    fontSize: size,
    fontWeight: logo?.weight ?? '700',
    fontStyle: logo?.italic ? 'italic' : 'normal',
  });
}

/**
 * Paints one brand's ad, laid out for the SHAPE of the slot it is going on.
 *
 * The ad areas on the car are nothing like each other — the floor strip is
 * eighteen times wider than it is tall, the mirror plate is square — and a
 * single texture stretched across both was unreadable on one and squashed on
 * the other. So the texture is painted at the slot's own aspect ratio and the
 * lockup is chosen to suit it:
 *
 *   very wide   wordmark only, filling the strip
 *   wide        mark on the left, wordmark beside it
 *   square-ish  mark above, wordmark under
 *
 * and in the middle case, if fitting the wordmark next to the mark would
 * shrink it past legibility, the mark is dropped and the word gets the whole
 * plate. Text is MEASURED, not estimated: the brands run from "APEX" to
 * "CHRONARC" and a guessed glyph width overflows the plate on the long ones.
 */
/**
 * The plate outline actually drawn, from the brand's preference and the shape
 * of the ad area. A circle stamped on an 18:1 floor strip is a dot with a lot
 * of wasted strip either side, and a hexagon squashed to that ratio is a
 * lozenge — so `round` always becomes a badge with the wordmark beside it,
 * and `hex` gives way to a pill once the area gets long.
 */
function resolvePlate(
  logo: Brand['logo'],
  aspect: number,
): 'none' | 'rect' | 'pill' | 'hex' | 'badge' {
  if (logo.plate === false) return 'none';
  switch (logo.shape ?? 'rect') {
    case 'round':
      return 'badge';
    case 'hex':
      return aspect > 6 ? 'pill' : 'hex';
    case 'pill':
      // A pill on a square area is a circle, which throws away the corners and
      // leaves the wordmark hanging off the curve at the bottom.
      return aspect <= 1.35 ? 'rect' : 'pill';
    default:
      return 'rect';
  }
}

function paintDecalPng(brand: Brand, slot: SlotKey, surfaceHex: string): Uint8Array {
  const aspect = slotByKey(slot).aspect;
  const w = Math.round(aspect >= 1 ? DECAL_TEX_LONG : DECAL_TEX_LONG * aspect);
  const h = Math.round(aspect >= 1 ? DECAL_TEX_LONG / aspect : DECAL_TEX_LONG);
  const surface = Skia.Surface.MakeOffscreen(w, h);
  if (!surface) throw new Error('Could not create an offscreen Skia surface for a sponsor decal');
  const canvas = surface.getCanvas();
  const { logo } = brand;
  const kind = resolvePlate(logo, aspect);
  const bgHex = logo.bg ?? brand.color;

  const bgPaint = Skia.Paint();
  bgPaint.setColor(Skia.Color(bgHex));
  bgPaint.setAntiAlias(true);

  // The plate as one path, so its fill and its gloss share an outline exactly.
  const platePath = Skia.Path.Make();
  if (kind === 'rect' || kind === 'pill') {
    const r = kind === 'pill' ? Math.min(w, h) / 2 : Math.min(w, h) * 0.12;
    platePath.addRRect(Skia.RRectXY(Skia.XYWHRect(0, 0, w, h), r, r));
  } else if (kind === 'hex') {
    const cut = Math.min(h * 0.32, w * 0.22);
    platePath.moveTo(cut, 0);
    platePath.lineTo(w - cut, 0);
    platePath.lineTo(w, h / 2);
    platePath.lineTo(w - cut, h);
    platePath.lineTo(cut, h);
    platePath.lineTo(0, h / 2);
    platePath.close();
  }

  if (kind !== 'none' && kind !== 'badge') {
    canvas.drawPath(platePath, bgPaint);
    // A light sweep so the ad reads as printed vinyl rather than a flat swatch.
    // Kept gentle: the logo has to stay the brightest thing on the plate.
    const sheen = Skia.Paint();
    sheen.setAntiAlias(true);
    sheen.setShader(
      Skia.Shader.MakeLinearGradient(
        { x: 0, y: 0 },
        { x: w * 0.65, y: h },
        [Skia.Color('#FFFFFF40'), Skia.Color('#FFFFFF00'), Skia.Color('#00000022')],
        [0, 0.45, 1],
        TileMode.Clamp,
      ),
    );
    canvas.drawPath(platePath, sheen);
  }

  // On a plate the logo uses its own ink; printed onto the car it cannot —
  // #14060A on a midnight-blue body is an invisible ad — so it takes a tone
  // chosen against the paint underneath, the way a team prints a sponsor
  // straight onto the bodywork. A badge is both at once: the mark sits on the
  // brand's colour, the wordmark on the paint.
  const paintInk = contrastInk(surfaceHex);
  const markHex = kind === 'none' ? paintInk : logo.ink;
  const wordHex = kind === 'none' || kind === 'badge' ? paintInk : logo.ink;

  const word = logo.word ?? brand.short;
  const pad = Math.min(w, h) * 0.13;
  const innerW = w - pad * 2;
  const innerH = h - pad * 2;

  const tracking = logo.tracking ?? 0.05;

  /**
   * How wide the plate actually is at a given height. A rounded rectangle is
   * as wide at the bottom as in the middle; a circle, a pill and a hexagon are
   * not — and fitting the wordmark to the bounding box is what pushed NIMBUS9
   * straight out through the sides of its own badge.
   */
  const widthAtRow = (y: number) => {
    if (kind === 'hex') {
      const cut = Math.min(h * 0.32, w * 0.22);
      const t = Math.min(1, Math.abs(y - h / 2) / (h / 2));
      return w - 2 * cut * t;
    }
    if (kind === 'pill' || kind === 'badge') {
      const r = Math.min(w, h) / 2;
      const dy = Math.min(r, Math.abs(y - h / 2));
      const inset = r - Math.sqrt(Math.max(0, r * r - dy * dy));
      return w - 2 * inset;
    }
    return w;
  };

  /** Largest font size at which `word` fits `avail` px wide, capped. */
  const fitSize = (avail: number, cap: number) => {
    const probe = decalFont(100, logo);
    const unit = (probe.getTextWidth(word) + 100 * tracking * (word.length - 1)) / 100;
    return Math.max(6, Math.min(cap, avail / unit));
  };
  const drawWord = (x: number, baseline: number, size: number, centred: boolean) => {
    const font = decalFont(size, logo);
    const paint = Skia.Paint();
    paint.setColor(Skia.Color(wordHex));
    paint.setAntiAlias(true);
    const gap = size * tracking;
    const glyphs = [...word];
    const total = glyphs.reduce((sum, g) => sum + font.getTextWidth(g), 0) + gap * (glyphs.length - 1);
    let cursor = centred ? x - total / 2 : x;
    for (const g of glyphs) {
      canvas.drawText(g, cursor, baseline, paint, font);
      cursor += font.getTextWidth(g) + gap;
    }
  };
  const drawMark = (x: number, y: number, box: number) => {
    if (!logo.mark) return;
    const path = Skia.Path.MakeFromSVGString(logo.mark);
    if (!path) return;
    path.setFillType(logo.evenOdd ? FillType.EvenOdd : FillType.Winding);
    const paint = Skia.Paint();
    paint.setColor(Skia.Color(markHex));
    paint.setAntiAlias(true);
    if (logo.stroke) {
      paint.setStyle(PaintStyle.Stroke);
      paint.setStrokeWidth(logo.stroke);
    }
    canvas.save();
    canvas.translate(x, y);
    canvas.scale(box / 100, box / 100);
    canvas.drawPath(path, paint);
    canvas.restore();
  };
  /** The circular field a `round` brand's mark sits on. */
  const drawBadge = (cx: number, cy: number, diameter: number) => {
    canvas.drawCircle(cx, cy, diameter / 2, bgPaint);
    drawMark(cx - diameter * 0.31, cy - diameter * 0.31, diameter * 0.62);
  };

  if (aspect >= 6) {
    if (kind === 'badge') {
      const d = innerH;
      drawBadge(pad + d / 2, h / 2, d);
      const size = fitSize(innerW - d - pad, innerH * 0.74);
      drawWord(pad + d + pad + (innerW - d - pad) / 2, h / 2 + size * 0.35, size, true);
    } else {
      const size = fitSize(widthAtRow(h / 2) - pad * 2, innerH * 0.74);
      drawWord(w / 2, h / 2 + size * 0.35, size, true);
    }
  } else if (aspect <= 1.35) {
    const box = innerH * 0.60;
    if (kind === 'badge') {
      drawBadge(w / 2, pad + box / 2, box);
    } else {
      drawMark((w - box) / 2, pad, box);
    }
    const baseline = h - pad * 0.9;
    const size = fitSize(widthAtRow(baseline) - pad * 2, innerH * 0.20);
    drawWord(w / 2, baseline, size, true);
  } else {
    const box = innerH * 0.92;
    const gap = pad * 0.8;
    const beside = fitSize(widthAtRow(h / 2) - pad * 2 - box - gap, innerH * 0.56);
    if (beside < innerH * 0.34 && kind !== 'badge') {
      const size = fitSize(widthAtRow(h / 2) - pad * 2, innerH * 0.62);
      drawWord(w / 2, h / 2 + size * 0.35, size, true);
    } else {
      if (kind === 'badge') {
        drawBadge(pad + box / 2, h / 2, box);
      } else {
        drawMark(pad, (h - box) / 2, box);
      }
      drawWord(pad + box + gap, h / 2 + beside * 0.35, beside, false);
    }
  }

  surface.flush();
  return surface.makeImageSnapshot().encodeToBytes(ImageFormat.PNG, 100);
}

/**
 * Writes (or reuses) the cache file for one brand's decal and returns its
 * `file://` URI. Keyed by brand — every slot a brand occupies shares one PNG.
 */
function decalFileUri(brand: Brand, slot: SlotKey, surfaceHex: string): string {
  // A plateless ad's ink depends on the paint beneath it, so the cache key has
  // to carry that too — otherwise switching to a dark livery would reuse the
  // black-on-dark texture painted for the light one.
  // A plateless ad's ink — and a badge's wordmark — depend on the paint
  // beneath, so the cache key has to carry that too, or switching to a dark
  // livery would reuse the black-on-dark texture painted for the light one.
  const onPaint = brand.logo.plate === false || brand.logo.shape === 'round';
  const tone = onPaint ? `-${contrastInk(surfaceHex).slice(1)}` : '';
  const file = new File(Paths.cache, `car-decal-${brand.key}-${slot}${tone}.png`);
  if (!file.exists) {
    file.write(paintDecalPng(brand, slot, surfaceHex));
  }
  return file.uri;
}

/** One signed slot: loads its brand's decal texture and paints it onto the plate. */
function SponsorDecalEntity({
  slot,
  brand,
  surfaceHex,
}: {
  slot: SlotKey;
  brand: Brand;
  surfaceHex: string;
}) {
  const uri = useMemo(() => decalFileUri(brand, slot, surfaceHex), [brand, slot, surfaceHex]);
  const texture = useBuffer({ source: { uri } });
  const materialName = `PW_Decal_${slot}`;

  if (texture == null) return null;
  return (
    <EntitySelector
      byName={materialName}
      materialParameters={{
        index: 0,
        parameters: {
          // White base colour so the texture's own colours show unmodified —
          // baseColorFactor multiplies the texture sample.
          baseColorFactor: [1, 1, 1, 1],
          // A printed vinyl sticker, not the bodywork's wet-look clear-coat.
          roughnessFactor: 0.38,
          metallicFactor: 0.0,
        },
      }}
      textureMap={{ materialName, textureSource: texture }}
    />
  );
}

/**
 * What an EMPTY slot should match — mirrors `SPONSOR_DECALS`' `surface`
 * column in `tools/blender/build_toon_car.py` exactly. "paint" slots sit on
 * bodywork and take the same colour `cover_mat` does (the livery's primary,
 * or secondary for a duotone livery); "carbon" slots (halo, floor edge) sit
 * on trim and take the livery's trim colour instead.
 */
const SPONSOR_SURFACE: Record<SlotKey, 'paint' | 'carbon'> = {
  sidepod: 'paint',
  coverFront: 'paint',
  coverMid: 'paint',
  coverRear: 'paint',
  noseFront: 'paint',
  noseRear: 'paint',
  rearWingMain: 'carbon',
  rearWingTop: 'paint',
  rearWingLow: 'paint',
  frontWingEnd: 'paint',
  frontWingFlap: 'carbon',
  cockpitFront: 'paint',
  cockpitRear: 'paint',
  halo: 'carbon',
  mirror: 'paint',
  floorEdge: 'carbon',
};
const SPONSOR_SLOT_KEYS = Object.keys(SPONSOR_SURFACE) as SlotKey[];

/** An unsold slot: repainted to disappear into whatever it sits on. */
function EmptySponsorSlotEntity({
  slot,
  liveryData,
}: {
  slot: SlotKey;
  liveryData: ReturnType<typeof liveryByKey>;
}) {
  const carbon = SPONSOR_SURFACE[slot] === 'carbon';
  const hex = surfaceHexFor(slot, liveryData);
  return (
    <EntitySelector
      byName={`PW_Decal_${slot}`}
      materialParameters={{
        index: 0,
        parameters: {
          baseColorFactor: hexToLinearRGBA(hex),
          roughnessFactor: carbon ? 0.4 : 0.22,
          metallicFactor: carbon ? 0.35 : 0.05,
        },
      }}
    />
  );
}

/** How long the outgoing spec's model stays visible under the incoming one. */
const SWAP_MS = 260;

interface CarTurntableProps {
  width: number;
  height: number;
  /** Development spec — picks which model is loaded. Defaults to B. */
  spec?: SpecLetter;
  livery?: string;
  compound?: CompoundKey;
  rim?: string;
  /** Signed sponsor deals — each paints its slot's decal plate live. */
  sponsorships?: Sponsorship[];
}

export function CarTurntable({
  width,
  height,
  spec = 'B',
  livery = 'pitwall',
  compound = 'SOFT',
  rim = 'accent',
  sponsorships,
}: CarTurntableProps) {
  // A model swap (spec change) can't cross-fade two live GL scenes cheaply,
  // so instead the view dips out and back in around the reload — enough to
  // read as "the parts changed" without the hard pop of an instant swap.
  const opacity = useSharedValue(1);
  const mountedSpec = useRef(spec);
  useEffect(() => {
    if (spec === mountedSpec.current) return;
    mountedSpec.current = spec;
    opacity.value = withTiming(0, { duration: SWAP_MS / 2, easing: Easing.in(Easing.ease) }, () => {
      opacity.value = withTiming(1, { duration: SWAP_MS, easing: Easing.out(Easing.ease) });
    });
  }, [spec, opacity]);
  const fadeStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  if (width <= 0 || height <= 0) return null;

  return (
    <Animated.View style={[{ width, height }, fadeStyle]}>
      <FilamentScene>
        <Scene
          width={width}
          height={height}
          spec={spec}
          livery={livery}
          compound={compound}
          rim={rim}
          sponsorships={sponsorships}
        />
      </FilamentScene>

      <View className="absolute bottom-2 right-3" pointerEvents="none">
        <AppText variant="labelSmall" color={colors.textTertiary} uppercase style={{ fontSize: 9 }}>
          Sürükleyerek döndür
        </AppText>
      </View>
    </Animated.View>
  );
}

interface SceneProps {
  width: number;
  height: number;
  spec: SpecLetter;
  livery: string;
  compound: CompoundKey;
  rim: string;
  sponsorships?: Sponsorship[];
}

function Scene({ width, height, spec, livery, compound, rim, sponsorships }: SceneProps) {
  // Fixed home position/target in "unit cube" space — `transformToUnitCube`
  // below normalises every spec's model (they're different lengths: a T3 car
  // carries a longer diffuser and rear wing) to the same ~1m box, so the
  // camera rig never needs to know the car's actual bounding box.
  const cameraManipulator = useCameraManipulator({
    orbitHomePosition: [1.55, 0.85, 2.05],
    targetPosition: [0, 0.05, 0],
    upVector: [0, 1, 0],
    orbitSpeed: [0.0026, 0.0026],
  });

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .maxPointers(1)
        .onBegin((e) => {
          'worklet';
          cameraManipulator?.grabBegin(e.translationX, height - e.translationY, false);
        })
        .onUpdate((e) => {
          'worklet';
          cameraManipulator?.grabUpdate(e.translationX, height - e.translationY);
        })
        .onEnd(() => {
          'worklet';
          cameraManipulator?.grabEnd();
        }),
    [cameraManipulator, height],
  );

  const liveryData = liveryByKey(livery);
  const compoundData = compoundByKey(compound);
  const rimColorHex = resolveRimColor(rimByKey(rim), liveryData);
  const targets = RECOLOR_TARGETS[spec];

  return (
    <GestureDetector gesture={pan}>
      <FilamentView style={{ width, height }}>
        <DefaultLight />
        <Camera cameraManipulator={cameraManipulator} />
        <Model source={MODELS[spec]} transformToUnitCube>
          {targets.map((name) => (
            <EntitySelector
              key={name}
              byName={name}
              materialParameters={{
                index: 0,
                parameters: { baseColorFactor: colorForTarget(name, liveryData, compoundData, rimColorHex) },
              }}
            />
          ))}
          {SPONSOR_SLOT_KEYS.map((slot) => {
            const deal = sponsorships?.find((d) => d.slot === slot);
            const brand = deal ? brandByKey(deal.brandKey) : undefined;
            return brand ? (
              <SponsorDecalEntity
                key={slot}
                slot={slot}
                brand={brand}
                surfaceHex={surfaceHexFor(slot, liveryData)}
              />
            ) : (
              <EmptySponsorSlotEntity key={slot} slot={slot} liveryData={liveryData} />
            );
          })}
        </Model>
      </FilamentView>
    </GestureDetector>
  );
}
