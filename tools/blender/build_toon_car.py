"""
Pit Wall — stylised 2026-generation F1 car.

Same catalogue, same CLI and the same turntable / sprite pipeline as
build_f1_car.py, but the geometry follows the 2026 regulation car (low nose
flowing into the front wing, deep-undercut sidepods, swan-neck rear wing on
tall endplates, wheel covers) with proportions pushed toward "toy": wheels a
touch oversized, body plumper, panel edges rounded, plus an ink outline and
a bright, glossy studio so the livery pops.

  blender --background --factory-startup --python build_toon_car.py -- \
      --livery pitwall --compound SOFT --rim accent \
      --render out.png --view hero

  blender --background --factory-startup --python build_toon_car.py -- \
      --turntable 24 --render frames/ --width 1280 --height 544

Extra options:
  --no-outline   drop the ink outline (for the .glb export)
"""

import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_f1_car as base  # noqa: E402
from build_f1_car import (  # noqa: E402
    annulus, box, build_materials, cylinder, finish, loft, material,
    reset_collection, revolve, torus, tyre_profile, wing_element,
)
from car_config import COMPOUNDS, LIVERIES, RIM_SPOKES, describe_spec  # noqa: E402

COLLECTION = base.COLLECTION
_base_setup_studio = base.setup_studio

# ── 2026 layout, slightly compressed ────────────────────────────────────────
#
# The 2026 regulations shrink the car: 1900 mm wide (was 2000), 3400 mm
# wheelbase (was 3600), narrower tyres. `CAR_HALF_WIDTH` is the hard outer
# limit — every wheel is placed by its OUTER face, not its centreline, so
# fitting wider tyres at GRIP T2/T3 makes the car look planted instead of
# making it illegally wide, and the front wing can span the full body width
# without the endplates ever landing inside a tyre.
FRONT_AXLE = 1.72
REAR_AXLE = -1.76
TRACK_HALF = 0.84            # kept for build_f1_car compatibility
CAR_HALF_WIDTH = 0.95
OUTLINE = True

# Nothing that belongs to the front wing may reach back into the front tyre.
# The tyre's leading edge is FRONT_AXLE + tyre_r (0.405 at GRIP T3), so the
# rearmost wing surface has to stay ahead of this line. `check_front_wing_gap`
# asserts it at build time rather than leaving it to be spotted in a render —
# that intersection is exactly what shipped before.
FW_CLEARANCE = 0.06
FW_REAR_LIMIT = FRONT_AXLE + 0.405 + FW_CLEARANCE   # 2.185


# ── Look ────────────────────────────────────────────────────────────────────

def outline_material():
    """Flat ink, only ever seen from the inside of a flipped hull."""
    mat = bpy.data.materials.get("PW_Outline") or bpy.data.materials.new("PW_Outline")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    emit = nodes.new("ShaderNodeEmission")
    emit.inputs["Color"].default_value = (0.012, 0.012, 0.018, 1.0)
    emit.inputs["Strength"].default_value = 1.0
    links.new(emit.outputs[0], out.inputs[0])
    mat.use_backface_culling = True
    return mat


def add_outline(obj, thickness):
    """Inverted-hull ink line: a flipped, slightly inflated copy of the shell."""
    if not OUTLINE or obj.type != "MESH":
        return
    ink = outline_material()
    if ink.name not in [m.name for m in obj.data.materials]:
        obj.data.materials.append(ink)
    mod = obj.modifiers.new("Outline", "SOLIDIFY")
    mod.thickness = thickness
    mod.offset = 1.0          # grow OUTWARD; flipped normals make it a rim
    mod.use_flip_normals = True
    mod.use_rim = False
    mod.material_offset = len(obj.data.materials) - 1
    mod.use_quality_normals = True


def shell(obj, mat, coll, bevel=0.0, smooth_angle=40.0, ink=0.014):
    finish(obj, mat, coll, bevel=bevel, smooth_angle=smooth_angle)
    add_outline(obj, ink)
    return obj


# ── Monocoque spine ─────────────────────────────────────────────────────────
#
# Module level, because the suspension has to know where the skin actually is.
# (x, centre_z, half_width, half_height, superellipse exponent)
BODY = [
    (-2.42, 0.340, 0.050, 0.050, 3.0),   # rear crash structure
    (-2.10, 0.360, 0.100, 0.090, 3.2),
    (-1.70, 0.400, 0.155, 0.135, 3.4),
    (-1.20, 0.440, 0.215, 0.185, 3.6),
    (-0.70, 0.470, 0.265, 0.220, 3.8),
    (-0.20, 0.470, 0.290, 0.232, 4.2),
    (0.30, 0.450, 0.280, 0.212, 4.4),
    (0.85, 0.410, 0.245, 0.182, 4.4),
    (1.20, 0.360, 0.195, 0.145, 4.0),
    (1.60, 0.300, 0.155, 0.112, 3.8),
    (2.00, 0.250, 0.125, 0.082, 3.6),
    (2.26, 0.205, 0.118, 0.072, 3.4),
    (2.46, 0.160, 0.098, 0.060, 3.2),
    (2.64, 0.115, 0.072, 0.048, 3.0),    # tip, sunk into the wing's main plane
]


def body_at(x):
    """
    (centre_z, half_width, half_height) of the monocoque at a station, linearly
    interpolated between BODY rows. Suspension arms start here instead of at a
    hand-typed y, which is why they used to begin 5 cm out in open air: the
    chassis is 0.155 wide at the front axle, the old arms started at 0.20.
    """
    rows = sorted(BODY)
    if x <= rows[0][0]:
        return rows[0][1], rows[0][2], rows[0][3]
    if x >= rows[-1][0]:
        return rows[-1][1], rows[-1][2], rows[-1][3]
    for a, b in zip(rows, rows[1:]):
        if a[0] <= x <= b[0]:
            t = (x - a[0]) / (b[0] - a[0])
            return tuple(a[i] + (b[i] - a[i]) * t for i in (1, 2, 3))
    return rows[-1][1], rows[-1][2], rows[-1][3]


def plate(name, outline, half_thickness, y, sign=1):
    """
    An endplate: a closed XZ polygon extruded along Y.

    Boxes cannot do the swept, cut-away corners the 2026 wings actually have,
    and a rotated box reads as a slab from three-quarter views. Points may
    carry a third value, an OUTWARD bow: a real front wing endplate is not
    flat, it leans out as it rises, and a perfectly flat plate is exactly what
    made this one read as a slab of card stood on edge. `sign` says which side
    of the car the bow leans toward.
    """
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    rings = []
    for side in (-1, 1):
        rings.append([
            bm.verts.new((point[0],
                          y + side * half_thickness
                          + sign * (point[2] if len(point) > 2 else 0.0),
                          point[1]))
            for point in outline
        ])
    n = len(outline)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((rings[0][i], rings[0][j], rings[1][j], rings[1][i]))
    bm.faces.new(rings[0][::-1])
    bm.faces.new(rings[1])
    bm.normal_update()
    bm.to_mesh(mesh)
    bm.free()
    return bpy.data.objects.new(name, mesh)


def inset_profile(outline, amount=0.055):
    """
    The same profile, pulled toward its own centre.

    The painted skin on an endplate used to be a SECOND hand-typed outline
    that had to be nudged every time the plate's shape changed — and drifted
    from it twice. Deriving it means the carbon rim stays an even width by
    construction.
    """
    cx = sum(p[0] for p in outline) / len(outline)
    cz = sum(p[1] for p in outline) / len(outline)
    return [
        (p[0] + (cx - p[0]) * amount, p[1] + (cz - p[1]) * amount)
        + tuple(p[2:])
        for p in outline
    ]


def beam(name, a, b, thick, width):
    """
    A box whose local Z runs from point a to point b.

    Struts used to be placed as a centre plus a rotation, which means neither
    end is stated anywhere and both have to be re-derived by hand whenever
    something near them moves. The halo pillar is the cautionary tale: at
    58 degrees about Y from (0.66, 0.72) it ended at x=0.813 while the ring it
    holds sits at x=0.523 — a rod leaning the wrong way, into open air.
    """
    a, b = Vector(a), Vector(b)
    d = b - a
    obj = box(name, (thick, width, d.length), tuple((a + b) / 2))
    obj.rotation_euler = d.to_track_quat("Z", "Y").to_euler()
    return obj


def swept_wing(name, chord, span, thickness, location, rotation=(0, 0, 0),
               camber=0.30, arch=0.0, tip_chord=1.0, twist=0.0, segments=12):
    """
    An aerofoil lofted ACROSS its span, instead of extruded straight.

    `wing_element` puts the same section at both tips and stretches it between
    them, which makes a plank: head-on, the front wing read as three flat bars
    with no aerofoil anywhere in it — "aero hiç yok gibi". A real front wing
    does three things a plank cannot. It ARCHES up toward the endplates, so the
    centre runs low over the track and the tips rise. It gains CHORD outboard,
    because that is where the outwash is made. And it TWISTS its tip down, so
    the outer span works at a different angle from the middle.

      arch       metres the tip rises above the centre (parabolic)
      tip_chord  chord multiplier at the tip, 1.0 = constant
      twist      degrees the tip section rotates nose-down
    """
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    steps = 10

    def section(c):
        top, bottom = [], []
        for i in range(steps + 1):
            t = i / steps
            x = (t - 0.5) * c
            th = thickness * math.sin(math.pi * min(1.0, t * 1.15)) ** 0.7
            drop = camber * c * (t ** 2) * 0.5
            top.append((x, -drop + th * 0.5))
            bottom.append((x, -drop - th * 0.5))
        return top + bottom[::-1]

    rings = []
    for j in range(segments + 1):
        u = j / segments
        k = abs(2 * u - 1)                       # 0 at the centreline, 1 at a tip
        c = chord * (1 + (tip_chord - 1) * k ** 1.5)
        lift = arch * k ** 2
        a = math.radians(twist) * k
        ca, sa = math.cos(a), math.sin(a)
        rings.append([
            bm.verts.new((x * ca - z * sa, (u - 0.5) * span, x * sa + z * ca + lift))
            for x, z in section(c)
        ])

    n = len(rings[0])
    for a_ring, b_ring in zip(rings, rings[1:]):
        for i in range(n):
            j2 = (i + 1) % n
            bm.faces.new((a_ring[i], a_ring[j2], b_ring[j2], b_ring[i]))
    bm.faces.new(rings[0][::-1])
    bm.faces.new(rings[-1])
    bm.normal_update()
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    obj.location = location
    obj.rotation_euler = rotation
    return obj


def check_front_wing_gap(x_rear_most):
    """Guard rail for the defect this rebuild was for: wing inside the tyre."""
    if x_rear_most < FW_REAR_LIMIT:
        raise SystemExit(
            f"front wing reaches x={x_rear_most:.3f}, inside the front tyre "
            f"(limit {FW_REAR_LIMIT:.3f}) — move the wing forward"
        )


def glossy_materials(livery, compound, rim):
    """The base set, with paint pushed toward toy-gloss."""
    mats = build_materials(livery, compound, rim)
    for key in ("paint", "paint_dark", "accent"):
        bsdf = mats[key].node_tree.nodes["Principled BSDF"]
        bsdf.inputs["Roughness"].default_value = 0.22
        bsdf.inputs["Coat Weight"].default_value = 0.6
        bsdf.inputs["Coat Roughness"].default_value = 0.08
    mats["visor"] = material("PW_Visor", (0.08, 0.10, 0.14, 1.0), 0.05, 0.9, coat=1.0)
    mats["cockpit"] = material("PW_Cockpit", (0.030, 0.030, 0.036, 1.0), 0.85, 0.0)
    return mats


# ── Wheels: 2026 covered rims ───────────────────────────────────────────────

def build_wheel(label, x, y, sign, width, tyre_r, mats, coll, spec, spokes, compound):
    axle_z = tyre_r
    rim_r = tyre_r * 0.62
    half_w = width / 2
    shoulder = tyre_r * 0.20

    sidewall_y = y + sign * half_w
    face_y = y + sign * (half_w - 0.006)

    tyre = revolve(f"PW_Tyre{label}",
                   tyre_profile(tyre_r, rim_r, half_w, shoulder=shoulder), segments=56)
    tyre.location = (x, y, axle_z)
    shell(tyre, mats["rubber"], coll, smooth_angle=60.0, ink=0.018)

    crown = revolve(f"PW_Crown{label}", [
        (tyre_r * 1.003, -half_w * 0.52), (tyre_r * 1.003, half_w * 0.52),
        (tyre_r * 0.994, half_w * 0.52), (tyre_r * 0.994, -half_w * 0.52),
    ], segments=56)
    crown.location = (x, y, axle_z)
    finish(crown, mats["rubber_worn"], coll, bevel=0.0, smooth_angle=60.0)

    if compound["grooved"]:
        for k in range(14):
            a = 2 * math.pi * k / 14
            groove = box(f"PW_Groove{label}{k}", (0.030, width * 0.80, tyre_r * 0.10),
                         (x + math.sin(a) * tyre_r * 0.97, y, axle_z + math.cos(a) * tyre_r * 0.97),
                         rotation=(0, a, 0))
            finish(groove, mats["rubber_worn"], coll, bevel=0.004)

    # Wide compound band — the strongest colour cue on the wheel.
    band = annulus(f"PW_CompoundBand{label}",
                   rim_r * 1.05, rim_r + (tyre_r - shoulder - rim_r) * 0.72,
                   0.010, segments=56)
    band.location = (x, sidewall_y + sign * 0.004, axle_z)
    finish(band, mats["band"], coll, bevel=0.0, smooth_angle=None)

    barrel = cylinder(f"PW_RimBarrel{label}", rim_r * 0.99, width * 0.84, (x, y, axle_z),
                      rotation=(math.radians(90), 0, 0), segments=44)
    finish(barrel, mats["rim_dark"], coll, bevel=0.005)

    # Dished wheel cover: outer lip, shallow bowl, then a proud centre boss.
    cover = revolve(f"PW_WheelCover{label}", [
        (rim_r * 0.99, 0.0), (rim_r * 0.99, 0.014),
        (rim_r * 0.86, 0.014), (rim_r * 0.60, -0.018), (rim_r * 0.30, -0.026),
        (rim_r * 0.18, -0.010), (rim_r * 0.18, 0.012), (0.0, 0.012), (0.0, 0.0),
    ], segments=48)
    cover.location = (x, face_y - sign * 0.008, axle_z)
    cover.scale.y = sign
    shell(cover, mats["rim"], coll, smooth_angle=50.0, ink=0.008)

    parts = spec["parts"]
    # GRIP T2: accent ring on the cover. T3 covers are already the accent
    # colour, so the ring flips dark to keep contrast.
    if parts["rim_ring"]:
        ring = annulus(f"PW_CoverRing{label}", rim_r * 0.64, rim_r * 0.72, 0.008, segments=48)
        ring.location = (x, face_y - sign * 0.012, axle_z)
        finish(ring, mats["rim_dark"] if parts["rim_upgrade"] else mats["accent"],
               coll, bevel=0.0, smooth_angle=None)

    # Vent dots: T1 runs a plain disc.
    count = RIM_SPOKES[spokes] if parts["rim_ring"] else 0
    for k in range(count):
        a = 2 * math.pi * k / count
        vent = cylinder(f"PW_Vent{label}{k}", rim_r * 0.045, 0.014,
                        (x + math.cos(a) * rim_r * 0.44, face_y - sign * 0.020,
                         axle_z + math.sin(a) * rim_r * 0.44),
                        rotation=(math.radians(90), 0, 0), segments=12)
        finish(vent, mats["rim_dark"], coll, bevel=0.0, smooth_angle=None)

    nut = cylinder(f"PW_LockNut{label}", rim_r * 0.14, 0.040,
                   (x, face_y + sign * 0.014, axle_z),
                   rotation=(math.radians(90), 0, 0), segments=6)
    finish(nut, mats["accent"] if parts["rim_ring"] else mats["rim_dark"], coll, bevel=0.004)


def suspension(label, x, sign, wheel_y, width, tyre_r, mats, coll, front):
    """
    Wishbones that actually join two things.

    Both ends used to be guesses. The inboard end was a fixed y (0.20 front,
    0.30 rear) while the chassis is only ~0.15 half-wide there, so every arm
    started in mid-air; the outboard end was aimed at the wheel's *outer*
    face, so the arms crossed over the tyre and died on the wheel cover.
    Now the root is read off the monocoque skin with `body_at()` and the tip
    lands on an upright tucked just inside the inner sidewall, where a real
    upright lives — from outside the tyre hides it, which is the point.
    """
    cz, hw, hh = body_at(x)
    hub_y = sign * (abs(wheel_y) - width / 2 + 0.035)
    root = sign * hw
    top_z, bot_z = tyre_r + 0.115, tyre_r - 0.125

    def rod(name, a, b, r, mat="carbon"):
        a, b = Vector(a), Vector(b)
        d = b - a
        obj = cylinder(name, r, d.length, (a + b) / 2,
                       rotation=d.to_track_quat("Z", "Y").to_euler(), segments=10)
        finish(obj, mats[mat], coll, bevel=0.0, smooth_angle=None)

    # The upright: what the arms bolt to, and what makes the joint read as a
    # joint rather than four rods ending at the same point in space.
    up = box(f"PW_Upright{label}", (0.085, 0.048, top_z - bot_z + 0.08),
             (x, hub_y, tyre_r - 0.005))
    finish(up, mats["carbon"], coll, bevel=0.012)

    for i, dx in enumerate((0.20, -0.17)):
        rod(f"PW_UpperArm{label}{i}", (x + dx, root * 0.94, cz + hh * 0.42),
            (x, hub_y, top_z), 0.017)
    for i, dx in enumerate((0.22, -0.19)):
        rod(f"PW_LowerArm{label}{i}", (x + dx, root * 0.99, cz - hh * 0.70),
            (x, hub_y, bot_z), 0.018)
    # Steering arm ahead of the front axle, toe link behind the rear one.
    tie_dx = -0.24 if front else 0.24
    rod(f"PW_TieRod{label}", (x + tie_dx, root * 0.96, cz - hh * 0.15),
        (x + tie_dx * 0.22, hub_y, tyre_r + 0.01), 0.013)
    if front:
        # Pushrod: bottom of the upright up into the top of the chassis.
        rod(f"PW_Pushrod{label}", (x + 0.02, hub_y, bot_z + 0.02),
            (x - 0.26, root * 0.55, cz + hh * 0.90), 0.014)
    else:
        rod(f"PW_Pullrod{label}", (x - 0.02, hub_y, top_z - 0.02),
            (x + 0.28, root * 0.60, cz - hh * 0.55), 0.014)
        # Driveshaft — the rear wheels have to be driven by something.
        shaft = cylinder(f"PW_Driveshaft{label}", 0.036, abs(hub_y) - 0.05,
                         (x, sign * (abs(hub_y) + 0.05) / 2, tyre_r),
                         rotation=(math.radians(90), 0, 0), segments=12)
        finish(shaft, mats["carbon_light"], coll, bevel=0.0, smooth_angle=None)


def surface_tree(obj):
    """World-space BVH of one object, for asking where its skin actually is."""
    mw = obj.matrix_world
    return BVHTree.FromPolygons([mw @ v.co for v in obj.data.vertices],
                                [list(p.vertices) for p in obj.data.polygons],
                                all_triangles=False)


def conform_decal(name, size, seed, host, coll, mat, lift=0.004, res=(10, 6), along="x"):
    """
    A sponsor decal as a patch that FOLLOWS the panel it is stuck to.

    Plates used to be axis-aligned boxes at hand-typed coordinates — the code
    said so itself ("Rotations are skipped") — which on a 2026 body that curves
    almost everywhere means a plate half-buried at one end and lifted at the
    other. Orienting a flat plate to the surface normal fixes the angle but not
    the curvature: the bigger the ad, the further its corners stand off, and
    the sidepod ad is the one that should be biggest.

    So the patch is sampled onto the panel instead. A grid of points across the
    decal's footprint is projected onto the host's skin, lifted `lift` off it
    along the local normal, and stitched into a quad mesh carrying a clean 0..1
    UV — so a runtime texture lands square, and the whole ad sits on the
    bodywork at a constant height however the panel rolls underneath it.

    Returns None when the host panel does not exist in this spec, so a slot
    whose part is tier-gated goes unplaced instead of crashing.
    """
    if host is None:
        return None
    tree = surface_tree(host)
    seed = Vector(seed)

    def outward(point, reference=None):
        hit, normal, _, _ = tree.find_nearest(point, 2.0)
        if hit is None:
            return None, None
        n = Vector(normal).normalized()
        if (seed - hit).dot(n) < 0:          # inward-facing polygon; flip it
            n = -n
        # Near a panel's edge the nearest surface can be round the back of it.
        # Anything facing away from the patch's own direction is that, and is
        # dropped rather than dragging a corner of the ad around the edge.
        if reference is not None and n.dot(reference) < 0.35:
            return None, None
        return hit, n

    def basis(n):
        # Which way the ad READS. Most run along the car, but one across a rear
        # wing runs along its span — and a wing's main plane faces backwards,
        # where "along the car" degenerates to nothing anyway.
        forward = Vector((0.0, 1.0, 0.0)) if along == "y" else Vector((1.0, 0.0, 0.0))
        tangent = forward - n * forward.dot(n)
        if tangent.length < 1e-4:            # panel faces along that axis
            tangent = Vector((0.0, 0.0, 1.0)) - n * n.z
        t = tangent.normalized()
        return t, t.cross(n)

    centre, n = outward(seed)
    if centre is None:
        return None
    # Average the normal over the footprint first: a single polygon's normal is
    # whatever facet happens to be nearest, which on a faceted round panel (the
    # halo tube) differed between the left and right copies of the same ad.
    t, b = basis(n)
    samples = [n]
    for du, dv in ((0.5, 0.0), (-0.5, 0.0), (0.0, 0.5), (0.0, -0.5)):
        _, sn = outward(centre + t * (du * size[0]) + b * (dv * size[1]) + n * 0.05, n)
        if sn is not None:
            samples.append(sn)
    n = sum(samples, Vector((0.0, 0.0, 0.0))).normalized()
    t, b = basis(n)

    nu, nv = res
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new()
    grid = []
    for j in range(nv + 1):
        row = []
        for i in range(nu + 1):
            u, v = i / nu - 0.5, j / nv - 0.5
            flat = centre + t * (u * size[0]) + b * (v * size[1])
            hit, hn = outward(flat + n * 0.12, n)
            if hit is None:                  # ran off the panel: stay planar
                hit, hn = flat, n
            row.append((bm.verts.new(hit + hn * lift), (i / nu, j / nv)))
        grid.append(row)
    for j in range(nv):
        for i in range(nu):
            quad = (grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i])
            face = bm.faces.new([v for v, _ in quad])
            for loop, (_, uv) in zip(face.loops, quad):
                loop[uv_layer].uv = uv
    bm.normal_update()
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    finish(obj, mat, coll, bevel=0.0, smooth_angle=None)
    return obj


# ── Sponsor decals ──────────────────────────────────────────────────────────
#
# Eight flat plates, matching the slot keys in mobile/src/data/sponsors.ts
# (SlotKey / sponsorSlots) exactly, so the app can recolour each one by name
# the same way it repaints the livery. They sit at fixed body-relative spots
# regardless of development spec — a sponsor deal isn't gated by a car part
# existing, so the plate is always there even at T1 (e.g. "floorEdge" has a
# decal even though the floor-edge winglet itself only appears at AERO T2+).
#
# Most slots mirror onto both flanks under the SAME material name — join_by_
# material() then merges the pair into one mesh, so a single EntitySelector
# repaints both sides at once, exactly like PW_Primary already covers dozens
# of surfaces. "engineCover" is a single top-mounted plate, unmirrored.
#
# (name, size, location, mirrored, axis, surface) — location.y is the
# RIGHT-side (s=+1) placement; the mirrored copy negates it. `axis` names
# which pair of faces is UV-mapped for a texture — "Y" (outward flank) for
# everything except the top-mounted "engineCover" plate, which faces "Z".
# `surface` says what an UNSOLD slot should look like: "paint" (the same
# colour and gloss as the bodywork it sits on) or "carbon" (the trim colour
# the halo and floor edge are actually moulded from) — an empty slot has to
# read as bare bodywork, not a grey sticker with nothing on it, so the app
# repaints it to match its surroundings whenever no sponsor owns it (see
# `CarTurntable.tsx`'s `SPONSOR_SURFACE`, which mirrors this column exactly).
# Rotations are skipped: on a car this toy-proportioned the small mismatch
# against a curved or angled panel doesn't read, and it keeps every decal a
# plain axis-aligned plate.
# Where the car carries branding — modelled on how real cars are signed.
#
# A 2025 Mercedes, Red Bull and Ferrari all do the same thing: ONE enormous
# title sponsor across the sidepod, a vertical STACK of three medium logos
# down the engine cover, two along the nose, one big name across the rear
# wing's main plane with a pair on its endplate, and small ones around the
# cockpit, halo, mirror and front wing. Sixteen positions, grouped into eleven
# areas. Keys match `mobile/src/data/sponsors.ts::sponsorSlots` exactly.
#
#   size   = (length, height) in metres — the ad's real footprint
#   seed   = a point OUTSIDE the panel; the patch is projected onto whatever
#            surface is nearest, so what matters is the direction you look
#            at the car from, not an exact coordinate
#   hosts  = "|"-separated fallback chain for tier-gated panels
#   lift   = how far off the panel. Not just z-fighting clearance: the livery's
#            own stripes are geometry, wrapping the body 14 mm proud of it, so
#            anything the paint crosses has to clear it or the stripe runs over
#            the top of the ad.
#   along  = which way the ad reads: "x" down the car, "y" across it
SPONSOR_DECALS = {
    "sidepod":      ((0.72, 0.215), (-0.55, 0.78, 0.395), "PW_Sidepod{s}", True, "paint", 0.018, "x"),
    "coverFront":   ((0.30, 0.072), (-0.50, 0.40, 0.860), "PW_Airbox", True, "paint", 0.018, "x"),
    "coverMid":     ((0.30, 0.072), (-0.92, 0.38, 0.800), "PW_Airbox", True, "paint", 0.018, "x"),
    "coverRear":    ((0.26, 0.062), (-1.32, 0.34, 0.715), "PW_Airbox", True, "paint", 0.018, "x"),
    "noseFront":    ((0.26, 0.085), (2.30, 0.0, 0.600), "PW_Monocoque", False, "paint", 0.020, "x"),
    "noseRear":     ((0.42, 0.105), (1.68, 0.32, 0.290), "PW_Monocoque", True, "paint", 0.020, "x"),
    "rearWingMain": ((0.80, 0.110), (-2.38, 0.0, 1.25), "PW_RearMain", False, "carbon", 0.006, "y"),
    "rearWingTop":  ((0.26, 0.075), (-2.42, 0.75, "top"), "PW_RearEndplate{s}", True, "paint", 0.005, "x"),
    "rearWingLow":  ((0.26, 0.075), (-2.42, 0.75, "low"), "PW_RearEndplate{s}", True, "paint", 0.005, "x"),
    "frontWingEnd": ((0.30, 0.120), (2.55, 1.12, 0.190), "PW_FrontEndplate{s}", True, "paint", 0.005, "x"),
    "frontWingFlap": ((0.70, 0.075), (2.48, 0.0, 0.60), "PW_FrontFlap0", False, "carbon", 0.006, "y"),
    "cockpitFront": ((0.17, 0.052), (0.42, 0.34, 0.540), "PW_Monocoque", True, "paint", 0.020, "x"),
    "cockpitRear":  ((0.17, 0.052), (0.05, 0.36, 0.560), "PW_Monocoque", True, "paint", 0.020, "x"),
    "halo":         ((0.150, 0.042), (0.18, 0.42, 0.885), "PW_HaloRing", True, "carbon", 0.005, "x"),
    "mirror":       ((0.052, 0.055), (0.55, 0.70, 0.645), "PW_Mirror{s}", True, "paint", 0.005, "x"),
    "floorEdge":    ((0.84, 0.046), (-0.35, 0.80, 0.120), "PW_FloorEdge{s}|PW_Floor", True, "carbon", 0.005, "x"),
}


def sponsor_decals(mats, coll, ep_cz, ep_h, cover_color, trim_color):
    """
    Bakes the unsold look to match the surface each plate sits on: the same
    glossy-paint params `glossy_materials()` gives the bodywork for "paint"
    slots, the same params `build_materials()` gives carbon trim for
    "carbon" ones. This is only the export-time default — the app always
    repaints every slot on load (sold or not) so it tracks the *selected*
    livery, but a stray render of the raw .glb (docs, `preview_toon.sh`)
    should still look dressed rather than showing blank grey plates.
    """
    for key, (size, seed, hosts, mirrored, surface, lift, along) in SPONSOR_DECALS.items():
        x, y, z = seed
        # The rear endplate's height is tier-dependent (0.38 at AERO T3, 0.22
        # at T1), so the pair of ads on it are seeded as FRACTIONS of it. A
        # fixed offset put the lower one off the bottom of the short plate.
        if z is None:
            z = ep_cz
        elif z == "top":
            z = ep_cz + 0.22 * ep_h
        elif z == "low":
            z = ep_cz - 0.22 * ep_h
        if surface == "carbon":
            mat = material(f"PW_Decal_{key}", trim_color, 0.40, 0.35)
        else:
            mat = material(f"PW_Decal_{key}", cover_color, 0.22, 0.05, coat=0.6)
        # Every ad material blends, because a brand may choose to print
        # straight onto the bodywork with no plate behind it — that decal's
        # texture carries an alpha background, and an OPAQUE material would
        # render the empty area as a solid block instead of showing the paint.
        # A fully opaque texture on a blending material looks identical.
        for attr, value in (("blend_method", "BLEND"), ("surface_render_method", "BLENDED")):
            if hasattr(mat, attr):
                setattr(mat, attr, value)
        for s in ((1, -1) if mirrored else (1,)):
            # `hosts` is a "|"-separated fallback chain: the floor-edge plate
            # rides the edge winglet when AERO has unlocked it and the floor
            # itself when it has not.
            host = next((bpy.data.objects.get(n.format(s=s))
                         for n in hosts.split("|")
                         if bpy.data.objects.get(n.format(s=s))), None)
            conform_decal(f"PW_Decal_{key}{s}", size, (x, s * y, z), host, coll, mat,
                          lift=lift, along=along)


# ── The car ─────────────────────────────────────────────────────────────────

def build_car(motor, aero, grip, livery="pitwall", compound="SOFT",
              rim="silver", spokes="multi", style=None):
    spec = describe_spec(motor, aero, grip)
    parts = spec["parts"]
    gT = spec["tiers"]["grip"]
    livery_data = LIVERIES[livery]
    style = style or livery_data["style"]
    compound_data = COMPOUNDS[compound]

    coll = reset_collection()
    mats = glossy_materials(livery, compound, rim)

    cover_mat = mats["paint_dark"] if style == "duotone" else mats["paint"]
    # Everything behind the cockpit bulkhead. "duotone" paints the whole car in
    # the second tone; "split" keeps the tub in the primary and darkens only
    # the rear, which is why the two need separate handles.
    rear_mat = mats["paint_dark"] if style in ("duotone", "split") else cover_mat
    stripe_mat = mats["accent"]
    stripe2_mat = mats["paint_dark"] if style != "duotone" else mats["accent"]

    # Oversized "toy" wheels. 2026 tyres are narrower than the 2022-25 ones,
    # and a wider GRIP tier now eats into the car's fixed outer width rather
    # than pushing past it (see CAR_HALF_WIDTH).
    tyre_r = 0.385 + (gT - 1) * 0.010
    w_scale = compound_data["width_scale"]
    tyre_w_front = (0.330 + (gT - 1) * 0.022) * w_scale
    tyre_w_rear = (0.425 + (gT - 1) * 0.026) * w_scale

    # ── Monocoque: low 2026 nose rising into a tall cockpit, cover swooping down ──
    body = loft("PW_Monocoque", BODY, segments=32)
    shell(body, cover_mat, coll, ink=0.016)

    # Airbox + engine cover hump — round on top, fairs into the body.
    airbox = loft("PW_Airbox", [
        (-0.15, 0.80, 0.110, 0.140, 3.0),
        (-0.50, 0.83, 0.145, 0.150, 3.0),
        (-1.00, 0.78, 0.145, 0.140, 3.0),
        (-1.50, 0.68, 0.115, 0.110, 3.0),
        (-2.00, 0.55, 0.080, 0.080, 3.0),
        (-2.40, 0.42, 0.045, 0.045, 3.0),
    ], segments=24)
    shell(airbox, rear_mat, coll, ink=0.014)

    # Airbox intake: dark rounded mouth just above the driver's head.
    intake = loft("PW_Intake", [
        (-0.13, 0.82, 0.080, 0.105, 3.0),
        (-0.30, 0.82, 0.088, 0.112, 3.0),
    ], segments=20)
    finish(intake, mats["cockpit"], coll, bevel=0.0)

    if parts["airbox_scoop"]:
        # MOTOR T2: a raised accent lip over the intake — reads from every angle.
        scoop = loft("PW_Scoop", [
            (-0.08, 0.86, 0.100, 0.075, 3.0),
            (-0.22, 0.87, 0.118, 0.085, 3.0),
            (-0.42, 0.86, 0.120, 0.080, 3.0),
        ], segments=20, cap_back=False)
        shell(scoop, stripe_mat, coll, ink=0.010)

    if parts["power_spine"]:
        # MOTOR T3: accent spine running the length of the engine cover.
        spine = loft("PW_PowerSpine", [
            (-0.45, 0.975, 0.030, 0.014, 3.0),
            (-1.00, 0.915, 0.032, 0.014, 3.0),
            (-1.50, 0.785, 0.028, 0.012, 3.0),
            (-2.00, 0.628, 0.022, 0.010, 3.0),
            (-2.35, 0.470, 0.014, 0.008, 3.0),
        ], segments=12)
        finish(spine, stripe_mat, coll, bevel=0.0)

    if parts["cooling_gills"]:
        for s in (-1, 1):
            for k in range(4):
                gill = box(f"PW_Gill{s}{k}", (0.055, 0.012, 0.075),
                           (-1.05 - k * 0.13, s * (0.145 - k * 0.012), 0.70 - k * 0.04))
                gill.rotation_euler = (0, math.radians(-16), s * math.radians(12))
                finish(gill, stripe_mat, coll, bevel=0.0)

    if parts["shark_fin"]:
        fin = box("PW_SharkFin", (1.20, 0.022, 0.34), (-1.72, 0.0, 0.78))
        fin.rotation_euler = (0, math.radians(-14), 0)
        shell(fin, rear_mat, coll, bevel=0.008, ink=0.010)
        fin_edge = box("PW_SharkFinEdge", (1.20, 0.030, 0.035), (-1.72, 0.0, 0.955))
        fin_edge.rotation_euler = (0, math.radians(-14), 0)
        finish(fin_edge, stripe_mat, coll, bevel=0.0)

    # Cockpit opening, seat, helmet, halo.
    opening = loft("PW_CockpitOpening", [
        (0.60, 0.58, 0.150, 0.045, 3.0),
        (0.10, 0.64, 0.195, 0.070, 3.0),
        (-0.15, 0.65, 0.185, 0.070, 3.0),
    ], segments=20)
    finish(opening, mats["cockpit"], coll, bevel=0.0)

    helmet = cylinder("PW_Helmet", 0.16, 0.001, (0.05, 0.0, 0.785))
    helmet.data = bpy.data.meshes.new("PW_HelmetMesh")
    import bmesh
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=24, v_segments=14, radius=0.150)
    bm.to_mesh(helmet.data)
    bm.free()
    helmet.location = (0.05, 0.0, 0.785)
    shell(helmet, mats["accent"], coll, smooth_angle=60.0, ink=0.010)
    visor = box("PW_Visor", (0.11, 0.22, 0.080), (0.175, 0.0, 0.785))
    finish(visor, mats["visor"], coll, bevel=0.02, segments=4)

    # Halo: a horizontal ring around the cockpit, carried on THREE mounts —
    # a blade pillar at the front centre and two posts behind the driver's
    # shoulders — which is both how the real part is held and the only way
    # this ring is attached to the car at all. It clears the helmet by 15 mm
    # at every point, so the mounts are not decoration: without them the whole
    # hoop floats.
    halo_c, halo_z, halo_maj = 0.18, 0.885, 0.25
    halo_tilt = math.radians(6)          # nose-down, as on the real hoop
    halo = torus("PW_HaloRing", halo_maj, 0.028, (halo_c, 0.0, halo_z),
                 rotation=(0, halo_tilt, 0), major_seg=40, minor_seg=12)
    halo.scale = (1.32, 1.0, 1.0)
    shell(halo, mats["carbon"], coll, smooth_angle=60.0, ink=0.010)

    def halo_point(theta):
        """World position of the ring's centreline at a local angle."""
        lx, ly = halo_maj * 1.32 * math.cos(theta), halo_maj * math.sin(theta)
        return (halo_c + lx * math.cos(halo_tilt),
                ly,
                halo_z - lx * math.sin(halo_tilt))

    fx, _, fz = halo_point(0.0)
    pillar = beam("PW_HaloPillar", (fx, 0.0, fz + 0.012), (fx + 0.065, 0.0, 0.610),
                  0.038, 0.052)
    finish(pillar, mats["carbon"], coll, bevel=0.006)
    for s_ in (-1, 1):
        mx, my, mz = halo_point(math.radians(140))
        post = beam(f"PW_HaloMount{s_}", (mx, s_ * abs(my), mz + 0.010),
                    (mx - 0.02, s_ * (abs(my) + 0.02), 0.648), 0.044, 0.048)
        finish(post, mats["carbon"], coll, bevel=0.006)

    # Roll-hoop camera T-bar, mirrors.
    tbar = box("PW_TCam", (0.05, 0.30, 0.035), (-0.24, 0.0, 0.960))
    finish(tbar, mats["carbon"], coll, bevel=0.006)
    for s in (-1, 1):
        # The stalk has to start on the chassis flank (0.264 wide here), not
        # at a round number that leaves it hanging in the airstream.
        stalk = box(f"PW_MirrorStalk{s}", (0.03, 0.21, 0.02), (0.55, s * 0.295, 0.605))
        finish(stalk, mats["carbon"], coll, bevel=0.0)
        mirror = box(f"PW_Mirror{s}", (0.06, 0.13, 0.08), (0.55, s * 0.455, 0.645))
        shell(mirror, cover_mat, coll, bevel=0.015, ink=0.008)
        if parts["mirror_winglets"]:
            wl = box(f"PW_MirrorWinglet{s}", (0.10, 0.16, 0.012), (0.52, s * 0.475, 0.690))
            wl.rotation_euler = (s * math.radians(-10), 0, 0)
            finish(wl, stripe_mat, coll, bevel=0.0)

    # ── Sidepods: slim 2026 letterbox inlet, deep undercut, coke-bottle tail ──
    #
    # The waist is per-station (the loft's optional centre_y) rather than one
    # `location.y` for the whole pod: the old straight tube stayed 0.15 wide
    # all the way back and buried its tail in the rear tyre.
    for s in (-1, 1):
        pod = loft(f"PW_Sidepod{s}", [
            (0.50, 0.470, 0.130, 0.085, 3.4, s * 0.435),
            (0.25, 0.460, 0.195, 0.120, 3.6, s * 0.445),
            (-0.30, 0.420, 0.215, 0.145, 3.8, s * 0.440),
            (-0.85, 0.360, 0.185, 0.135, 3.8, s * 0.400),
            (-1.30, 0.310, 0.135, 0.100, 3.4, s * 0.320),
            (-1.70, 0.270, 0.080, 0.062, 3.0, s * 0.230),
            (-2.00, 0.260, 0.038, 0.030, 3.0, s * 0.170),
        ], segments=24)
        shell(pod, cover_mat, coll, ink=0.014)

        skirt = loft(f"PW_PodSkirt{s}", [
            (0.40, 0.295, 0.110, 0.055, 3.4, s * 0.395),
            (-0.30, 0.270, 0.140, 0.072, 3.6, s * 0.400),
            (-0.85, 0.245, 0.125, 0.070, 3.6, s * 0.365),
            (-1.30, 0.220, 0.085, 0.055, 3.2, s * 0.300),
            (-1.65, 0.210, 0.045, 0.036, 3.0, s * 0.220),
        ], segments=20)
        shell(skirt, mats["paint"] if style == "duotone" else mats["paint_dark"], coll, ink=0.010)

        # Inlet mouth — the 2026 letterbox: wide, shallow, set high.
        mouth = loft(f"PW_Inlet{s}", [
            (0.53, 0.482, 0.098, 0.040, 3.6, s * 0.435),
            (0.40, 0.480, 0.106, 0.046, 3.6, s * 0.437),
        ], segments=20)
        finish(mouth, mats["cockpit"], coll, bevel=0.0)
        # Inlet lip, so the mouth reads as an opening and not a dark sticker.
        lip = loft(f"PW_InletLip{s}", [
            (0.545, 0.483, 0.112, 0.055, 3.6, s * 0.435),
            (0.500, 0.482, 0.116, 0.058, 3.6, s * 0.436),
        ], segments=20, cap_front=False, cap_back=False)
        shell(lip, cover_mat, coll, ink=0.008)

        if parts["energy_pods"]:
            # MOTOR T2: half of the 2026 power unit is electric, and the
            # battery wants its own cooling — an accent duct riding the pod
            # shoulder, readable from every angle the game ever shows.
            duct = loft(f"PW_EnergyPod{s}", [
                (0.12, 0.520, 0.070, 0.048, 3.2, s * 0.400),
                (-0.25, 0.500, 0.082, 0.055, 3.2, s * 0.395),
                (-0.60, 0.455, 0.060, 0.042, 3.2, s * 0.370),
            ], segments=18)
            shell(duct, stripe_mat, coll, ink=0.008)

        if parts["engine_louvres"]:
            for k in range(5):
                louvre = box(f"PW_Louvre{s}{k}", (0.10, 0.012, 0.02),
                             (-0.55 - k * 0.14, s * (0.420 - k * 0.014), 0.530 - k * 0.022))
                louvre.rotation_euler = (0, 0, s * math.radians(20))
                finish(louvre, mats["carbon"], coll, bevel=0.0)

    if parts["bargeboards"]:
        # AERO T2: 2026 runs floor fences, not the old bargeboard stack — a
        # pair of turning vanes standing on the floor's leading edge.
        for s in (-1, 1):
            for k in range(2):
                bb = box(f"PW_FloorFence{s}{k}", (0.40 - k * 0.07, 0.014, 0.17 - k * 0.03),
                         (0.86 - k * 0.05, s * (0.40 + k * 0.11), 0.155))
                bb.rotation_euler = (0, math.radians(-8), s * math.radians(11 + k * 5))
                shell(bb, mats["carbon"], coll, bevel=0.004, ink=0.006)

    # ── Floor + edge wings + diffuser ──
    # Half-widths stay inside the tyres: the rear tyre's inner face is at
    # ~0.47, and the old floor was 0.78 wide right through it.
    floor = loft("PW_Floor", [
        (1.05, 0.075, 0.26, 0.018, 4.5),
        (0.60, 0.075, 0.58, 0.020, 5.0),
        (-0.30, 0.078, 0.62, 0.020, 5.0),
        (-1.15, 0.080, 0.56, 0.020, 5.0),
        (-1.45, 0.085, 0.43, 0.018, 4.5),
        (-2.05, 0.095, 0.41, 0.018, 4.5),
        (-2.35, 0.105, 0.38, 0.016, 4.0),
    ], segments=28)
    shell(floor, mats["carbon"], coll, ink=0.010)

    if parts["floor_edge_wing"]:
        for s in (-1, 1):
            edge = box(f"PW_FloorEdge{s}", (1.45, 0.030, 0.055), (-0.35, s * 0.615, 0.118))
            finish(edge, mats["carbon"], coll, bevel=0.006)
            # Accent lip so the upgrade reads against the dark floor.
            edge_lip = box(f"PW_FloorEdgeLip{s}", (1.20, 0.034, 0.012), (-0.35, s * 0.615, 0.151))
            finish(edge_lip, stripe_mat, coll, bevel=0.0)

    big = parts["big_diffuser"]
    diffuser = loft("PW_Diffuser", [
        (-1.85, 0.10, 0.38, 0.03, 4.0),
        (-2.20, 0.17, 0.42, 0.09, 4.0),
        (-2.48, 0.25 if not big else 0.29, 0.44 if not big else 0.48, 0.14 if not big else 0.19, 4.0),
    ], segments=24, cap_front=False)
    shell(diffuser, mats["carbon"], coll, ink=0.010)
    if parts["diffuser_strakes"]:
        for k in (-2, -1, 1, 2):
            strake = box(f"PW_Strake{k}", (0.50, 0.012, 0.16), (-2.22, k * 0.14, 0.17))
            finish(strake, mats["carbon_light"], coll, bevel=0.0)

    # ── Front wing: 2026 stack, sitting entirely AHEAD of the front tyres ──
    #
    # This is the defect that started the rebuild. The stack used to run back
    # to x=1.97 while the tyre's leading edge is at 2.11, so the endplate and
    # the top flap grew straight out of the wheel. Everything now lives ahead
    # of FW_REAR_LIMIT, the nose lands on top of the wing instead of ending
    # behind it, and `check_front_wing_gap` fails the build if that slips.
    fw_span = 1.90                       # 1900 mm: the 2026 full car width
    fw_half = fw_span / 2
    fw_rear = 1e9
    # Every element arches toward the endplates and gains chord as it goes,
    # so the wing has a shape head-on instead of being three stacked planks.
    FW_ARCH, FW_TIP = 0.048, 1.22
    main_chord, main_x = 0.46, 2.62
    main_plane = swept_wing("PW_FrontMain", main_chord, fw_span, 0.062,
                            (main_x, 0.0, 0.082), rotation=(0, math.radians(-4), 0),
                            camber=0.30, arch=FW_ARCH, tip_chord=FW_TIP, twist=-6)
    shell(main_plane, mats["paint_dark"], coll, ink=0.010)
    fw_rear = min(fw_rear, main_x - main_chord * FW_TIP / 2)
    flap_count = 1 + int(parts["front_flap_2"]) + int(parts["front_flap_3"])
    for k in range(flap_count):
        chord = 0.30 - k * 0.040
        cx = 2.500 - k * 0.070
        angle = -18 - k * 7
        flap = swept_wing(f"PW_FrontFlap{k}", chord, fw_span + 0.030, 0.040,
                          (cx, 0.0, 0.168 + k * 0.088),
                          rotation=(0, math.radians(angle), 0), camber=0.28,
                          arch=FW_ARCH + 0.006 * (k + 1), tip_chord=1.30, twist=-10)
        shell(flap, stripe_mat if k == flap_count - 1 else cover_mat, coll, ink=0.008)
        fw_rear = min(fw_rear, cx - chord * 1.30 / 2)
        # A slim accent line along the leading edge of each element — the
        # reference car draws the wing with stripes, not with bare surfaces.
        if k < flap_count - 1:
            edge = swept_wing(f"PW_FrontFlapEdge{k}", chord * 0.22, fw_span + 0.028, 0.026,
                              (cx + chord * 0.40, 0.0, 0.168 + k * 0.088),
                              rotation=(0, math.radians(angle), 0), camber=0.10,
                              arch=FW_ARCH + 0.006 * (k + 1), tip_chord=1.30, twist=-10)
            finish(edge, stripe_mat, coll, bevel=0.0)
    # Swept endplate: a profile, not a rotated slab — the 2026 plate is cut
    # away at the bottom rear and curls over at the top front.
    # (x, z, outward bow) — the plate is low and long where it meets the main
    # plane, rises over the flap stack behind it, and leans progressively
    # outboard as it climbs, which is the outwash shape a real one has.
    # The bow grows toward the plate's FRONT top, where nothing attaches. At
    # the rear top — where the flap tips have to land — it stays small, because
    # the first version curled the whole top edge outboard and carried the
    # plate clean off the end of the top flap.
    FW_ENDPLATE = [
        (2.26, 0.090, 0.000),
        (2.55, 0.018, 0.008),
        (2.86, 0.046, 0.022),
        (2.93, 0.152, 0.040),
        (2.86, 0.286, 0.058),
        (2.64, 0.374, 0.038),
        (2.40, 0.408, 0.016),
        (2.26, 0.332, 0.004),
    ]
    for s in (-1, 1):
        ep = plate(f"PW_FrontEndplate{s}", FW_ENDPLATE, 0.013, s * fw_half, sign=s)
        shell(ep, mats["carbon"], coll, bevel=0.008, ink=0.010)
        # Painted outer skin, so the livery still reaches the widest point of
        # the car. Derived from the plate's own profile rather than typed out
        # again, which is how the two used to drift apart.
        skin = plate(f"PW_FrontEPSkin{s}", inset_profile(FW_ENDPLATE),
                     0.004, s * (fw_half + 0.015), sign=s)
        finish(skin, cover_mat, coll, bevel=0.0, smooth_angle=None)
        if parts["endplate_lips"]:
            # AERO T3: the lip rides the plate's top edge, where the bow has
            # already carried it outboard.
            lip = box(f"PW_FrontLip{s}", (0.26, 0.085, 0.016),
                      (2.56, s * (fw_half + 0.070), 0.372))
            lip.rotation_euler = (s * math.radians(-24), 0, 0)
            finish(lip, stripe_mat, coll, bevel=0.006)
    fw_rear = min(fw_rear, 2.26)
    check_front_wing_gap(fw_rear)

    # ── Rear wing: grows with the aero tier ──
    #   T1  single element, short plain endplates, no beam wing
    #   T2  + flap, medium endplates with accent strip, beam wing
    #   T3  tall endplates, DRS flap swung open
    rw_span = 1.05
    rw_z = 0.83
    rw_x = -2.38
    rmain = wing_element("PW_RearMain", 0.42, rw_span, 0.060, (rw_x, 0.0, rw_z),
                         rotation=(0, math.radians(-14), 0), camber=0.30)
    shell(rmain, mats["carbon"], coll, ink=0.010)
    if parts["rear_flap"]:
        # 2026 active aero flattens the flap in low-drag mode; DRS alone just
        # opens the slot gap.
        drs_angle = -6 if parts["active_aero"] else -20 if parts["rear_drs_open"] else -34
        rflap = wing_element("PW_RearFlap", 0.27, rw_span, 0.045, (rw_x - 0.20, 0.0, rw_z + 0.135),
                             rotation=(0, math.radians(drs_angle), 0), camber=0.25)
        shell(rflap, stripe_mat, coll, ink=0.008)
    ep_h = 0.38 if parts["rear_endplate_tall"] else 0.30 if parts["rear_flap"] else 0.22
    ep_cz = rw_z + (0.07 if parts["rear_flap"] else -0.02)
    ep_x0, ep_x1 = rw_x + 0.20, rw_x - 0.26
    zb, zt = ep_cz - ep_h / 2, ep_cz + ep_h / 2
    # The cut-aways are fractions of the plate's own height: as fixed offsets
    # they were tuned against the 0.38-tall T3 plate, and on the 0.22-tall T1
    # one the bottom cut (0.15) rose above the top cut (0.13) and the outline
    # crossed itself — a twisted endplate on every base-spec car.
    for s in (-1, 1):
        ep = plate(f"PW_RearEndplate{s}", [
            (ep_x0, zb + 0.38 * ep_h), (ep_x0 + 0.17, zb + 0.03 * ep_h),
            (ep_x1 + 0.03, zb + 0.13 * ep_h), (ep_x1, zb + 0.50 * ep_h),
            (ep_x1, zt - 0.18 * ep_h), (ep_x1 + 0.09, zt),
            (ep_x0 + 0.11, zt), (ep_x0, zt - 0.34 * ep_h),
        ], 0.015, s * (rw_span / 2 + 0.015))
        shell(ep, rear_mat, coll, bevel=0.010, ink=0.012)
        if parts["rear_flap"]:
            strip = box(f"PW_RearEPStrip{s}", (0.38, 0.036, 0.038),
                        (rw_x - 0.10, s * (rw_span / 2 + 0.015), zt - 0.014))
            finish(strip, stripe_mat, coll, bevel=0.006)

    # Swan necks: from the top of the rear crash structure to the top surface
    # of the main plane. Both ends were floating before — the old pair started
    # 18 cm above the bodywork and stopped short of the wing.
    neck_base_z = body_at(-2.16)[0] + body_at(-2.16)[2] - 0.01
    for s in (-1, 1):
        finish(beam(f"PW_SwanNeck{s}", (-2.13, s * 0.105, neck_base_z),
                    (rw_x - 0.02, s * 0.105, rw_z + 0.035), 0.10, 0.030),
               mats["carbon"], coll, bevel=0.006)
    sponsor_decals(mats, coll, ep_cz, ep_h,
                   cover_color=(livery_data["secondary"] if style in ("duotone", "split")
                                else livery_data["primary"]),
                   trim_color=livery_data["trim"])

    if parts["beam_wing"]:
        beam_wing = wing_element("PW_BeamWing", 0.22, 0.86, 0.035, (-2.36, 0.0, 0.44),
                                 rotation=(0, math.radians(-22), 0), camber=0.3)
        shell(beam_wing, mats["carbon"], coll, ink=0.008)
    if parts["t_wing"]:
        twing = wing_element("PW_TWing", 0.14, 0.62, 0.025, (-1.95, 0.0, 0.665),
                             rotation=(0, math.radians(-10), 0))
        finish(twing, mats["carbon"], coll, bevel=0.0)

    # Exhaust + rain light.
    if parts["exhaust"]:
        er = 0.055 if parts["exhaust_large"] else 0.040
        pipe = cylinder("PW_Exhaust", er, 0.30, (-2.50, 0.0, 0.36),
                        rotation=(0, math.radians(90), 0), segments=20)
        shell(pipe, mats["carbon_light"], coll, ink=0.006)
        if parts["exhaust_glow"]:
            tip = annulus("PW_ExhaustTip", er * 0.55, er * 1.02, 0.030, segments=24, axis="X")
            tip.location = (-2.66, 0.0, 0.36)
            finish(tip, mats["glow"], coll, bevel=0.0, smooth_angle=None)
    rain = box("PW_RainLight", (0.06, 0.05, 0.12), (-2.44, 0.0, 0.300))
    finish(rain, material("PW_RainLightMat", (1.0, 0.2, 0.2, 1), 0.3, 0.0,
                          emission=(1.0, 0.15, 0.1, 1), emission_strength=4.0), coll, bevel=0.006)

    # ── Livery treatments: flat bands wrapped around the body ──
    def band(name, dz, hh, mat, upto=None):
        sts = [(x, cz + dz * (hh_b / 0.235), hw + 0.014, hh, e)
               for x, cz, hw, hh_b, e in BODY if upto is None or x <= upto]
        finish(loft(name, sts, segments=32), mat, coll, bevel=0.0)

    if style == "split":
        # Two-tone down the length: the second tone already covers the engine
        # cover, pods and rear wing via `rear_mat`, so all that is left is to
        # carry it over the tub's own skin up to the bulkhead and mark the
        # seam. The panel is lofted from the SAME stations as the monocoque,
        # 4 mm proud, so it hugs every curve instead of being a decal that
        # slides off the shoulder.
        split_x = 0.55
        scz, shw, shh = body_at(split_x)
        panel_sts = [(x, cz, hw + 0.004, hh + 0.004, e)
                     for x, cz, hw, hh, e in BODY if x < split_x]
        panel_sts.append((split_x, scz, shw + 0.004, shh + 0.004, 4.4))
        shell(loft("PW_SplitPanel", panel_sts, segments=32), rear_mat, coll, ink=0.012)

        ecz, ehw, ehh = body_at(split_x + 0.07)
        seam = loft("PW_SplitSeam", [
            (split_x, scz, shw + 0.009, shh + 0.009, 4.4),
            (split_x + 0.07, ecz, ehw + 0.009, ehh + 0.009, 4.4),
        ], segments=32)
        finish(seam, stripe_mat, coll, bevel=0.0)

    if style in ("stripe", "flash"):
        band("PW_Stripe", 0.060, 0.020, stripe_mat)
        band("PW_StripeB", 0.012, 0.014, stripe2_mat, upto=2.1)
        if style == "flash":
            for s in (-1, 1):
                pod_stripe = loft(f"PW_PodStripe{s}", [
                    (0.25, 0.502, 0.203, 0.013, 3.6, s * 0.445),
                    (-0.30, 0.471, 0.223, 0.013, 3.8, s * 0.440),
                    (-0.85, 0.407, 0.193, 0.012, 3.8, s * 0.400),
                    (-1.30, 0.345, 0.143, 0.010, 3.4, s * 0.320),
                ], segments=24)
                finish(pod_stripe, stripe_mat, coll, bevel=0.0)

    # Number roundel on the nose.
    roundel = cylinder("PW_Roundel", 0.075, 0.006, (1.55, 0.0, 0.418),
                       rotation=(0, math.radians(12), 0), segments=32)
    finish(roundel, mats["accent"] if style != "bare" else mats["paint_dark"], coll, bevel=0.0)

    # ── Wheels + suspension ──
    for label, x, width in (("FL", FRONT_AXLE, tyre_w_front), ("FR", FRONT_AXLE, tyre_w_front),
                            ("RL", REAR_AXLE, tyre_w_rear), ("RR", REAR_AXLE, tyre_w_rear)):
        s = 1 if label.endswith("L") else -1
        # Placed by the OUTER face: a wider tyre grows inboard, so the car
        # keeps its 1900 mm 2026 width at every GRIP tier and the front wing
        # can span that width without meeting a tyre.
        y = s * (CAR_HALF_WIDTH - width / 2)
        build_wheel(label, x, y, s, width, tyre_r, mats, coll, spec, spokes, compound_data)
        suspension(label, x, s, y, width, tyre_r, mats, coll, front=x > 0)
        if parts["brake_ducts"] and x > 0:
            # GRIP T2: accent brake-duct winglet on the front upright, just
            # inboard of the tyre's inner sidewall — inside the wheel it would
            # simply be buried in rubber, which is where it used to sit.
            duct = box(f"PW_BrakeDuct{label}", (0.22, 0.075, 0.016),
                       (x - 0.05, y - s * (width / 2 + 0.035), tyre_r * 0.92))
            duct.rotation_euler = (0, math.radians(-8), s * math.radians(18))
            finish(duct, stripe_mat, coll, bevel=0.0)
        # Brake drum peeking through the inboard side.
        drum = cylinder(f"PW_Drum{label}", tyre_r * 0.50, 0.06, (x, y, tyre_r),
                        rotation=(math.radians(90), 0, 0), segments=32)
        finish(drum, mats["carbon"], coll, bevel=0.0)

    return spec


# ── Bright toy-box studio ───────────────────────────────────────────────────

def setup_studio(view, transparent, resolution=(1600, 900)):
    scene = _base_setup_studio(view, transparent, resolution)
    boost = {"PW_Key": 2.6, "PW_Top": 1.9, "PW_Fill": 2.3, "PW_RimLight": 3.2}
    for name, k in boost.items():
        light = scene.objects.get(name)
        if light:
            light.data.energy *= k
    # Hard toy-box key: a sun gives crisp cel-like terminators the soft area
    # lights alone never do, and lifts the paint to its actual hue.
    sun_data = bpy.data.lights.new("PW_Sun", "SUN")
    sun_data.energy = 4.5
    sun_data.angle = math.radians(6)
    sun_data.color = (1.0, 0.97, 0.92)
    sun = bpy.data.objects.new("PW_Sun", sun_data)
    sun.rotation_euler = (math.radians(48), math.radians(-18), math.radians(35))
    scene.collection.objects.link(sun)

    # Cool navy ambient: lifts the shadow side without greying the paint.
    bg = scene.world.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value = (0.045, 0.085, 0.200, 1.0)
    bg.inputs["Strength"].default_value = 1.0
    floor = scene.objects.get("PW_StudioGround")
    if floor:
        bsdf = floor.data.materials[0].node_tree.nodes["Principled BSDF"]
        bsdf.inputs["Base Color"].default_value = base.srgb_to_linear((0.030, 0.050, 0.120, 1.0))
        bsdf.inputs["Roughness"].default_value = 1.0
        bsdf.inputs["Specular IOR Level"].default_value = 0.0
    return scene


def main():
    global OUTLINE
    if "--no-outline" in sys.argv:
        sys.argv.remove("--no-outline")
        OUTLINE = False
    base.FRONT_AXLE = FRONT_AXLE
    base.build_car = build_car
    base.setup_studio = setup_studio
    base.main()


if __name__ == "__main__":
    main()
