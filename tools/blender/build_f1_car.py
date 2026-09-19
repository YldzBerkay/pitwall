"""
Pit Wall — procedural cartoon-realistic F1 car, fully customisable.

Geometry is built from real-ish F1 proportions (5.6 m long, 2.0 m track,
3.6 m wheelbase) as a lofted monocoque rather than a box stack. Appearance and
part manifest come from car_config.py, so the same builder produces every
livery, tyre compound, rim finish and development spec the game needs.

  blender --background --factory-startup --python build_f1_car.py -- \
      --livery pitwall --compound SOFT --rim accent --rim-spokes multi \
      --motor 67 --aero 58 --grip 72 \
      --render out.png --view three-quarter

Options:
  --livery      pitwall | midnight | scarlet | monza | sunset | stealth | aqua
  --style       stripe | flash | duotone | split | bare  (overrides livery default)
  --compound    SOFT | MEDIUM | HARD | INTERMEDIATE | WET
  --rim         silver | graphite | gold | bronze | accent | primary | white
  --rim-spokes  blade | multi | turbine
  --view        three-quarter | hero | side | front | rear | top
"""

import argparse
import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

# car_config.py sits next to this file; Blender does not add that to sys.path.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from car_config import (  # noqa: E402
    COMPOUNDS, LIVERIES, RIMS, RIM_SPOKES, describe_spec, tier_of,
)

COLLECTION = "PW_F1_CAR"

# ── Chassis reference points (metres) ───────────────────────────────────────
FRONT_AXLE = 1.78
REAR_AXLE = -1.82
TRACK_HALF = 0.80


# ── Scene helpers ───────────────────────────────────────────────────────────

def reset_collection(clear_scene: bool = True) -> bpy.types.Collection:
    existing = bpy.data.collections.get(COLLECTION)
    if existing:
        for obj in list(existing.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.collections.remove(existing)
    if clear_scene:
        for obj in list(bpy.context.scene.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
    coll = bpy.data.collections.new(COLLECTION)
    bpy.context.scene.collection.children.link(coll)
    return coll


def srgb_to_linear(rgba):
    """
    The catalogue stores colours the way the app does — as sRGB hex values.
    Blender's Base Color socket expects LINEAR, and feeding sRGB numbers
    straight in is what makes a vivid livery render as a washed-out pastel.
    """
    def channel(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (channel(rgba[0]), channel(rgba[1]), channel(rgba[2]),
            rgba[3] if len(rgba) > 3 else 1.0)


def material(name, rgba, roughness, metallic, coat=0.0,
             emission=None, emission_strength=0.0, alpha=1.0):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = srgb_to_linear(rgba)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    for key, value in (("Coat Weight", coat), ("Alpha", alpha)):
        if key in bsdf.inputs:
            bsdf.inputs[key].default_value = value
    if emission and "Emission Color" in bsdf.inputs:
        bsdf.inputs["Emission Color"].default_value = srgb_to_linear(emission)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    return mat


def build_materials(livery_key: str, compound_key: str, rim_key: str):
    """Resolve the catalogue into the material set the builder paints with."""
    livery = LIVERIES[livery_key]
    compound = COMPOUNDS[compound_key]
    rim = RIMS[rim_key]

    rim_color = rim["color"]
    if rim_color == "@accent":
        rim_color = livery["accent"]
    elif rim_color == "@primary":
        rim_color = livery["primary"]

    return {
        # Low coat weight: a heavy clear-coat sheen desaturates the paint.
        "paint": material("PW_Primary", livery["primary"], 0.34, 0.05, coat=0.18),
        "paint_dark": material("PW_Secondary", livery["secondary"], 0.36, 0.05, coat=0.15),
        "accent": material("PW_Accent", livery["accent"], 0.32, 0.10, coat=0.18),
        "carbon": material("PW_Carbon", livery["trim"], 0.40, 0.35),
        "carbon_light": material(
            "PW_CarbonLight",
            tuple(min(1.0, c * 1.75) for c in livery["trim"][:3]) + (1.0,),
            0.48, 0.28,
        ),
        "rubber": material("PW_Tyre", (0.048, 0.050, 0.055, 1.0), 0.90, 0.0),
        "rubber_worn": material("PW_TyreCrown", (0.070, 0.072, 0.078, 1.0), 0.72, 0.0),
        "band": material("PW_CompoundBand", compound["band"], 0.42, 0.0),
        "rim": material("PW_Rim", rim_color, rim["roughness"], rim["metallic"], coat=0.3),
        "rim_dark": material("PW_RimBarrel", (0.098, 0.102, 0.114, 1.0), 0.38, 0.60),
        "glow": material("PW_HeatGlow", (0.890, 0.702, 0.255, 1.0), 0.5, 0.0,
                         emission=(1.0, 0.62, 0.22, 1.0), emission_strength=7.0, alpha=0.30),
    }


def finish(obj, mat, coll, bevel=0.012, segments=2, smooth_angle=38.0):
    """Link, paint, bevel hard edges, shade smooth by angle."""
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    coll.objects.link(obj)
    obj.data.materials.append(mat)
    if bevel:
        mod = obj.modifiers.new("Bevel", "BEVEL")
        mod.width = bevel
        mod.segments = segments
        mod.limit_method = "ANGLE"
        mod.angle_limit = math.radians(50)
    if smooth_angle is not None:
        for poly in obj.data.polygons:
            poly.use_smooth = True
        try:
            bpy.context.view_layer.objects.active = obj
            obj.select_set(True)
            bpy.ops.object.shade_auto_smooth(angle=math.radians(smooth_angle))
            obj.select_set(False)
        except (RuntimeError, AttributeError):
            pass
    return obj


# ── Geometry primitives ─────────────────────────────────────────────────────

def superellipse(half_w, half_h, exponent, segments=24):
    """Rounded-rectangle ring in the YZ plane. exponent 2 = ellipse."""
    pts = []
    p = 2.0 / exponent
    for i in range(segments):
        t = 2.0 * math.pi * i / segments
        ct, st = math.cos(t), math.sin(t)
        pts.append((
            half_w * math.copysign(abs(ct) ** p, ct),
            half_h * math.copysign(abs(st) ** p, st),
        ))
    return pts


def loft(name, stations, segments=24, cap_front=True, cap_back=True):
    """
    Tube from lofted rounded-rect sections: (x, center_z, hw, hh, exponent)
    with an optional sixth element, center_y. Without it every section stays
    on the centreline (the old behaviour); with it the tube can waist inward
    along its length — which is what a coke-bottle sidepod needs, since a
    single `location.y` offset can only move the whole pod, not narrow its
    tail away from the rear tyre.
    """
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    rings = []
    for station in stations:
        x, cz, hw, hh, exp = station[:5]
        cy = station[5] if len(station) > 5 else 0.0
        rings.append([bm.verts.new((x, cy + y, cz + z))
                      for y, z in superellipse(hw, hh, exp, segments)])
    for a, b in zip(rings, rings[1:]):
        for i in range(segments):
            j = (i + 1) % segments
            bm.faces.new((a[i], a[j], b[j], b[i]))
    if cap_back:
        bm.faces.new(rings[0][::-1])
    if cap_front:
        bm.faces.new(rings[-1])
    bm.normal_update()
    bm.to_mesh(mesh)
    bm.free()
    return bpy.data.objects.new(name, mesh)


def revolve(name, profile, segments=48, axis="Y"):
    """Revolve (radius, offset-along-axis) points around an axis."""
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    rings = []
    for i in range(segments):
        a = 2.0 * math.pi * i / segments
        ca, sa = math.cos(a), math.sin(a)
        ring = []
        for r, t in profile:
            if axis == "Y":
                ring.append(bm.verts.new((r * ca, t, r * sa)))
            elif axis == "Z":
                ring.append(bm.verts.new((r * ca, r * sa, t)))
            else:
                ring.append(bm.verts.new((t, r * ca, r * sa)))
        rings.append(ring)
    n = len(profile)
    for i in range(segments):
        a, b = rings[i], rings[(i + 1) % segments]
        for j in range(n):
            k = (j + 1) % n
            bm.faces.new((a[j], a[k], b[k], b[j]))
    bm.normal_update()
    bm.to_mesh(mesh)
    bm.free()
    return bpy.data.objects.new(name, mesh)


def annulus(name, r_inner, r_outer, thickness, segments=52, axis="Y"):
    """Flat ring — the tyre's compound sidewall band and the rim's outer lip."""
    return revolve(name, [
        (r_inner, -thickness / 2), (r_outer, -thickness / 2),
        (r_outer, thickness / 2), (r_inner, thickness / 2),
    ], segments=segments, axis=axis)


def tyre_profile(outer_r, inner_r, half_width, shoulder, arc_steps=6):
    """Slick cross-section: flat crown, generous rounded shoulders."""
    pts = [(inner_r, -half_width)]
    for i in range(arc_steps + 1):
        a = math.pi * 0.5 * i / arc_steps
        pts.append((outer_r - shoulder * (1 - math.sin(a)),
                    -half_width + shoulder * (1 - math.cos(a))))
    for i in range(arc_steps + 1):
        a = math.pi * 0.5 * i / arc_steps
        pts.append((outer_r - shoulder * (1 - math.cos(a)),
                    half_width - shoulder * (1 - math.sin(a))))
    pts.append((inner_r, half_width))
    return pts


def box(name, size, location, rotation=(0, 0, 0)):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    obj.location = location
    obj.rotation_euler = rotation
    return obj


def cylinder(name, radius, depth, location, rotation=(0, 0, 0), segments=32, radius_top=None):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(
        bm, cap_ends=True, cap_tris=False, segments=segments,
        radius1=radius, radius2=radius if radius_top is None else radius_top, depth=depth,
    )
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    obj.location = location
    obj.rotation_euler = rotation
    return obj


def torus(name, major, minor, location, rotation=(0, 0, 0), major_seg=48, minor_seg=14):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    rings = []
    for i in range(major_seg):
        a = 2 * math.pi * i / major_seg
        cx, cy = major * math.cos(a), major * math.sin(a)
        ring = []
        for j in range(minor_seg):
            b = 2 * math.pi * j / minor_seg
            r = minor * math.cos(b)
            ring.append(bm.verts.new((
                cx + r * math.cos(a), cy + r * math.sin(a), minor * math.sin(b),
            )))
        rings.append(ring)
    for i in range(major_seg):
        a, b = rings[i], rings[(i + 1) % major_seg]
        for j in range(minor_seg):
            k = (j + 1) % minor_seg
            bm.faces.new((a[j], a[k], b[k], b[j]))
    bm.normal_update()
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    obj.location = location
    obj.rotation_euler = rotation
    return obj


def wing_element(name, chord, span, thickness, location, rotation=(0, 0, 0), camber=0.35):
    """Cambered aerofoil plate — thin, curved trailing edge, reads as a wing."""
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    steps = 10
    top, bottom = [], []
    for i in range(steps + 1):
        t = i / steps
        x = (t - 0.5) * chord
        th = thickness * math.sin(math.pi * min(1.0, t * 1.15)) ** 0.7
        drop = camber * chord * (t ** 2) * 0.5
        top.append((x, -drop + th * 0.5))
        bottom.append((x, -drop - th * 0.5))
    section = top + bottom[::-1]
    rings = [[bm.verts.new((x, s, z)) for x, z in section] for s in (-span / 2, span / 2)]
    n = len(section)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((rings[0][i], rings[0][j], rings[1][j], rings[1][i]))
    bm.faces.new(rings[0][::-1])
    bm.faces.new(rings[1])
    bm.normal_update()
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    obj.location = location
    obj.rotation_euler = rotation
    return obj


# ── Wheel assembly ──────────────────────────────────────────────────────────

def build_wheel(label, x, y, sign, width, tyre_r, mats, coll, spec, spokes, compound):
    """
    F1 wheel: slick annulus with rounded shoulders, the coloured compound band
    on the flat sidewall, and a real rim — barrel, spoke face, polished lip and
    centre-lock nut.

    Everything is placed against explicit planes measured from the wheel
    centre, because anything set even a centimetre too far inboard disappears
    behind the tyre's sidewall.
    """
    axle_z = tyre_r
    rim_r = tyre_r * 0.635          # 18" rim on a 720 mm tyre
    half_w = width / 2
    shoulder = tyre_r * 0.16        # keeps a wide FLAT sidewall for the band

    sidewall_y = y + sign * half_w              # outer face of the rubber
    band_y = y + sign * (half_w + 0.004)        # band sits proud of the rubber
    rim_face_y = y + sign * (half_w - 0.010)    # visible through the rim hole

    tyre = revolve(f"PW_Tyre{label}",
                   tyre_profile(tyre_r, rim_r, half_w, shoulder=shoulder),
                   segments=56)
    tyre.location = (x, y, axle_z)
    finish(tyre, mats["rubber"], coll, bevel=0.0, smooth_angle=54.0)

    # Crown strip: a touch glossier, so the contact patch reads as tread.
    crown = revolve(f"PW_Crown{label}", [
        (tyre_r * 1.002, -half_w * 0.50), (tyre_r * 1.002, half_w * 0.50),
        (tyre_r * 0.996, half_w * 0.50), (tyre_r * 0.996, -half_w * 0.50),
    ], segments=56)
    crown.location = (x, y, axle_z)
    finish(crown, mats["rubber_worn"], coll, bevel=0.0, smooth_angle=54.0)

    # Intermediate / wet tyres carry visible tread blocks around the crown.
    if compound["grooved"]:
        for k in range(12):
            a = 2 * math.pi * k / 12
            groove = box(f"PW_Groove{label}{k}",
                         (0.034, width * 0.78, tyre_r * 0.12),
                         (x + math.sin(a) * tyre_r * 0.96, y,
                          axle_z + math.cos(a) * tyre_r * 0.96),
                         rotation=(0, a, 0))
            finish(groove, mats["rubber_worn"], coll, bevel=0.005)

    # Compound colour band on the flat sidewall — the F1 tell.
    band = annulus(f"PW_CompoundBand{label}",
                   rim_r + (tyre_r - shoulder - rim_r) * 0.22,
                   rim_r + (tyre_r - shoulder - rim_r) * 0.78,
                   0.010, segments=56)
    band.location = (x, band_y, axle_z)
    finish(band, mats["band"], coll, bevel=0.0, smooth_angle=None)

    # Rim barrel spanning the hole.
    barrel = cylinder(f"PW_RimBarrel{label}", rim_r * 0.99, width * 0.96, (x, y, axle_z),
                      rotation=(math.radians(90), 0, 0), segments=40)
    finish(barrel, mats["rim_dark"], coll, bevel=0.006)

    # Polished outer lip, right at the sidewall plane.
    lip = annulus(f"PW_RimLip{label}", rim_r * 0.88, rim_r * 0.995, 0.026, segments=44)
    lip.location = (x, sidewall_y - sign * 0.006, axle_z)
    finish(lip, mats["rim"], coll, bevel=0.0, smooth_angle=None)

    # Recessed dark face the spokes sit on top of.
    plate = annulus(f"PW_RimPlate{label}", tyre_r * 0.10, rim_r * 0.90, 0.014, segments=40)
    plate.location = (x, rim_face_y - sign * 0.028, axle_z)
    finish(plate, mats["rim_dark"], coll, bevel=0.0, smooth_angle=None)

    count = RIM_SPOKES[spokes]
    spoke_w = 0.034 if count <= 5 else 0.020 if count <= 10 else 0.013
    for k in range(count):
        # Boxes are double-ended, so half a turn covers the full star.
        a = math.pi * k / count
        spoke = box(f"PW_Spoke{label}{k}", (rim_r * 1.78, 0.020, spoke_w),
                    (x, rim_face_y, axle_z), rotation=(0, a, 0))
        finish(spoke, mats["rim"], coll, bevel=0.004)

    nut = cylinder(f"PW_LockNut{label}", tyre_r * 0.105, 0.050,
                   (x, rim_face_y + sign * 0.030, axle_z),
                   rotation=(math.radians(90), 0, 0), segments=6)
    finish(nut, mats["accent"] if spec["parts"]["rim_upgrade"] else mats["rim_dark"],
           coll, bevel=0.005)


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
    mats = build_materials(livery, compound, rim)

    # Colour roles per livery style.
    cover_mat = mats["paint_dark"] if style == "duotone" else mats["paint"]
    # The classic builder has no split panel; it shows the stripes instead.
    stripe_visible = style in ("stripe", "flash", "split")
    flash_visible = style == "flash"

    tyre_r = 0.352 + (gT - 1) * 0.010
    w_scale = compound_data["width_scale"]
    tyre_w_front = (0.315 + (gT - 1) * 0.030) * w_scale
    tyre_w_rear = (0.415 + (gT - 1) * 0.040) * w_scale

    # ── Monocoque + engine cover + nose ──
    # The tub holds its width to the front bulkhead, then a distinctly
    # narrower, flatter nose blade runs out to a blunt tip above the wing.
    body = loft("PW_Monocoque", [
        (-2.60, 0.46, 0.070, 0.070, 3.0),
        (-2.25, 0.48, 0.130, 0.125, 3.2),
        (-1.80, 0.52, 0.200, 0.185, 3.4),
        (-1.25, 0.56, 0.258, 0.230, 3.6),
        (-0.70, 0.56, 0.298, 0.245, 3.8),
        (-0.20, 0.53, 0.300, 0.235, 4.2),
        (0.30, 0.50, 0.282, 0.212, 4.4),
        (0.85, 0.47, 0.258, 0.186, 4.4),   # front bulkhead — still wide
        (1.10, 0.445, 0.200, 0.150, 4.0),  # step down into the nose
        (1.50, 0.420, 0.168, 0.122, 3.8),
        (1.95, 0.398, 0.144, 0.100, 3.6),
        (2.35, 0.380, 0.128, 0.083, 3.4),
        (2.52, 0.374, 0.120, 0.077, 3.4),  # blunt, FLAT blade tip ~24 cm across
    ], segments=28)
    finish(body, cover_mat, coll, bevel=0.0)

    spine = loft("PW_Spine", [
        (-2.30, 0.60, 0.042, 0.028, 3.0),
        (-1.70, 0.68, 0.055, 0.038, 3.0),
        (-1.10, 0.76, 0.062, 0.042, 3.0),
        (-0.58, 0.79, 0.062, 0.038, 3.0),
    ], segments=16)
    finish(spine, mats["paint_dark"] if style != "duotone" else mats["paint"], coll, bevel=0.0)

    if flash_visible:
        # Nose flash + engine-cover arrow in the accent colour.
        flash = loft("PW_NoseFlash", [
            (1.15, 0.588, 0.072, 0.030, 3.0),
            (1.80, 0.532, 0.062, 0.026, 3.0),
            (2.35, 0.470, 0.052, 0.022, 3.0),
            (2.52, 0.458, 0.046, 0.020, 3.0),
        ], segments=14)
        finish(flash, mats["accent"], coll, bevel=0.0)

    if parts["engine_louvres"]:
        for i in range(4):
            louvre = box(f"PW_Louvre{i}", (0.105, 0.170, 0.014),
                         (-1.05 - i * 0.145, 0.0, 0.735))
            finish(louvre, mats["carbon"], coll, bevel=0.004)

    # ── Sidepods: overlap the tub and reach the floor — one wide midsection ──
    for side, sign in (("L", 1), ("R", -1)):
        pod = loft(f"PW_Sidepod{side}", [
            (-1.66, 0.34, 0.060, 0.075, 3.4),
            (-1.35, 0.35, 0.130, 0.140, 3.8),
            (-0.85, 0.36, 0.225, 0.235, 4.4),
            (-0.30, 0.37, 0.258, 0.270, 4.6),
            (0.14, 0.37, 0.235, 0.272, 4.6),
            (0.36, 0.37, 0.150, 0.240, 4.2),
        ], segments=24)
        pod.location = (0.0, sign * 0.420, 0.0)
        finish(pod, mats["paint"], coll, bevel=0.0)

        inlet = box(f"PW_PodInlet{side}", (0.07, 0.215, 0.300), (0.385, sign * 0.420, 0.37))
        finish(inlet, mats["carbon"], coll, bevel=0.012)

        if stripe_visible:
            stripe = box(f"PW_PodStripe{side}", (1.28, 0.040, 0.034),
                         (-0.35, sign * 0.672, 0.45))
            finish(stripe, mats["accent"], coll, bevel=0.006)

        if parts["bargeboards"]:
            barge = box(f"PW_Bargeboard{side}", (0.46, 0.030, 0.215),
                        (0.60, sign * 0.555, 0.205),
                        rotation=(sign * math.radians(-10), 0, 0))
            finish(barge, mats["carbon_light"], coll, bevel=0.006)

    # ── Floor + edge wings + diffuser ──
    floor = box("PW_Floor", (3.68, 1.18, 0.042), (-0.70, 0.0, 0.052))
    finish(floor, mats["carbon"], coll, bevel=0.012)

    for side, sign in (("L", 1), ("R", -1)):
        edge = box(f"PW_FloorEdge{side}", (2.55, 0.048, 0.075),
                   (-0.90, sign * 0.585, 0.088), rotation=(sign * math.radians(14), 0, 0))
        finish(edge, mats["carbon_light"], coll, bevel=0.008)

    diffuser = loft("PW_Diffuser", [
        (-2.02, 0.105, 0.520, 0.050, 4.0),
        (-2.42, 0.190, 0.545, 0.090, 4.0),
        (-2.60, 0.245, 0.550, 0.105, 4.0),
    ], segments=16)
    finish(diffuser, mats["carbon"], coll, bevel=0.010)

    if parts["diffuser_strakes"]:
        for i, y in enumerate((-0.40, -0.14, 0.14, 0.40)):
            strake = box(f"PW_DiffuserStrake{i}", (0.52, 0.020, 0.150),
                         (-2.36, y, 0.185), rotation=(0, math.radians(-13), 0))
            finish(strake, mats["carbon_light"], coll, bevel=0.005)

    # ── Cockpit, driver, halo, airbox ──
    tub = box("PW_CockpitOpening", (0.86, 0.40, 0.09), (0.14, 0.0, 0.705))
    finish(tub, mats["carbon"], coll, bevel=0.022, segments=3)

    helmet = revolve("PW_Helmet",
                     [(0.0, 0.0)] + [
                         (0.132 * math.sin(math.pi * 0.5 * i / 8),
                          0.132 * math.cos(math.pi * 0.5 * i / 8)) for i in range(9)
                     ] + [(0.132, -0.055), (0.0, -0.055)],
                     segments=28, axis="Z")
    helmet.location = (0.10, 0.0, 0.700)
    finish(helmet, mats["accent"], coll, bevel=0.0)
    visor = box("PW_Visor", (0.075, 0.185, 0.062), (0.185, 0.0, 0.752))
    finish(visor, mats["carbon"], coll, bevel=0.012)

    halo = torus("PW_Halo", 0.40, 0.028, (0.30, 0.0, 0.815),
                 rotation=(0, math.radians(-7), 0), major_seg=44, minor_seg=10)
    finish(halo, mats["carbon_light"], coll, bevel=0.0)
    halo_stem = cylinder("PW_HaloStem", 0.030, 0.26, (0.695, 0.0, 0.735),
                         rotation=(0, math.radians(24), 0), segments=14)
    finish(halo_stem, mats["carbon_light"], coll, bevel=0.0)

    airbox = loft("PW_Airbox", [
        (-0.32, 0.815, 0.115, 0.098, 3.2),
        (-0.55, 0.815, 0.140, 0.120, 3.4),
        (-0.88, 0.785, 0.128, 0.108, 3.6),
    ], segments=20)
    finish(airbox, mats["paint"], coll, bevel=0.0)
    airbox_mouth = loft("PW_AirboxMouth", [
        (-0.30, 0.815, 0.092, 0.076, 3.2),
        (-0.24, 0.815, 0.086, 0.070, 3.2),
    ], segments=20)
    finish(airbox_mouth, mats["carbon"], coll, bevel=0.0)

    for side, sign in (("L", 1), ("R", -1)):
        mirror = box(f"PW_Mirror{side}", (0.085, 0.125, 0.052), (0.47, sign * 0.355, 0.665))
        finish(mirror, mats["carbon_light"], coll, bevel=0.010)
        stalk = box(f"PW_MirrorStalk{side}", (0.048, 0.155, 0.024), (0.47, sign * 0.245, 0.655))
        finish(stalk, mats["carbon"], coll, bevel=0.006)

    # ── Front wing (element count scales with AERO) ──
    fw_x = 2.50
    finish(wing_element("PW_FrontWingMain", 0.46, 1.90, 0.042, (fw_x, 0.0, 0.095),
                        rotation=(0, math.radians(-5), 0)),
           mats["carbon"], coll, bevel=0.006)
    if parts["front_flap_2"]:
        finish(wing_element("PW_FrontWingFlap2", 0.30, 1.84, 0.032, (fw_x - 0.14, 0.0, 0.175),
                            rotation=(0, math.radians(-13), 0)),
               mats["carbon"], coll, bevel=0.006)
    if parts["front_flap_3"]:
        finish(wing_element("PW_FrontWingFlap3", 0.24, 1.76, 0.028, (fw_x - 0.25, 0.0, 0.245),
                            rotation=(0, math.radians(-20), 0)),
               mats["carbon"], coll, bevel=0.006)

    ep_h = 0.21 + (spec["tiers"]["aero"] - 1) * 0.055
    for side, sign in (("L", 1), ("R", -1)):
        ep = box(f"PW_FrontEndplate{side}", (0.58, 0.030, ep_h),
                 (fw_x - 0.06, sign * 0.95, 0.085 + ep_h / 2),
                 rotation=(sign * math.radians(-7), 0, 0))
        finish(ep, mats["carbon_light"], coll, bevel=0.008)
        if parts["endplate_lips"]:
            lip = box(f"PW_FrontEndplateLip{side}", (0.055, 0.038, ep_h),
                      (fw_x - 0.33, sign * 0.95, 0.085 + ep_h / 2),
                      rotation=(sign * math.radians(-7), 0, 0))
            finish(lip, mats["accent"], coll, bevel=0.005)

    finish(cylinder("PW_NoseTip", 0.055, 0.05, (2.545, 0.0, 0.374),
                    rotation=(0, math.radians(90), 0), segments=20),
           mats["accent"], coll, bevel=0.0)

    for side, sign in (("L", 1), ("R", -1)):
        pillar = box(f"PW_NosePillar{side}", (0.085, 0.042, 0.24), (2.44, sign * 0.10, 0.215),
                     rotation=(0, math.radians(10), 0))
        finish(pillar, mats["carbon"], coll, bevel=0.006)

    # ── Rear wing ──
    rw_x, rw_z = -2.42, 0.90
    finish(wing_element("PW_RearWingMain", 0.40, 1.05, 0.045, (rw_x, 0.0, rw_z),
                        rotation=(0, math.radians(12), 0)),
           mats["carbon"], coll, bevel=0.006)
    if parts["rear_flap"]:
        finish(wing_element("PW_RearWingFlap", 0.26, 1.02, 0.032, (rw_x - 0.06, 0.0, rw_z + 0.15),
                            rotation=(0, math.radians(20), 0)),
               mats["carbon"], coll, bevel=0.006)
    if parts["rear_drs_open"]:
        finish(wing_element("PW_RearWingDRS", 0.28, 1.02, 0.032, (rw_x - 0.09, 0.0, rw_z + 0.19),
                            rotation=(0, math.radians(44), 0)),
               mats["carbon"], coll, bevel=0.006)
    if parts["t_wing"]:
        finish(wing_element("PW_TWing", 0.16, 0.52, 0.026, (-2.02, 0.0, 0.80),
                            rotation=(0, math.radians(8), 0)),
               mats["carbon_light"], coll, bevel=0.005)

    rep_h = 0.40 + (spec["tiers"]["aero"] - 1) * 0.055
    for side, sign in (("L", 1), ("R", -1)):
        ep = box(f"PW_RearEndplate{side}", (0.56, 0.030, rep_h),
                 (rw_x - 0.02, sign * 0.535, rw_z + 0.02))
        finish(ep, mats["carbon_light"], coll, bevel=0.010)
        if parts["endplate_lips"]:
            lip = box(f"PW_RearEndplateLip{side}", (0.050, 0.038, rep_h),
                      (rw_x - 0.28, sign * 0.535, rw_z + 0.02))
            finish(lip, mats["accent"], coll, bevel=0.005)

    finish(box("PW_WingPylon", (0.30, 0.065, 0.46), (rw_x + 0.10, 0.0, 0.66),
               rotation=(0, math.radians(-6), 0)),
           mats["carbon"], coll, bevel=0.010)

    if parts["shark_fin"]:
        finish(box("PW_SharkFin", (1.05, 0.030, 0.26), (-1.55, 0.0, 0.70)),
               mats["paint_dark"], coll, bevel=0.010)
        finish(box("PW_SharkFinEdge", (1.05, 0.038, 0.030), (-1.55, 0.0, 0.83)),
               mats["accent"], coll, bevel=0.006)

    # ── Exhaust ──
    if parts["exhaust"]:
        pipe_r = 0.072 if parts["exhaust_large"] else 0.055
        finish(cylinder("PW_Exhaust", pipe_r, 0.30, (-2.55, 0.0, 0.58),
                        rotation=(0, math.radians(90), 0), segments=20),
               mats["rim"], coll, bevel=0.006)
        finish(cylinder("PW_ExhaustInner", pipe_r * 0.66, 0.06, (-2.70, 0.0, 0.58),
                        rotation=(0, math.radians(90), 0), segments=18),
               mats["carbon"], coll, bevel=0.0)
    if parts["heat_haze"]:
        finish(cylinder("PW_HeatHaze", 0.052, 0.34, (-2.90, 0.0, 0.58),
                        rotation=(0, math.radians(-90), 0), segments=20, radius_top=0.13),
               mats["glow"], coll, bevel=0.0)

    # ── Wheels + suspension ──
    for label, x, width in (
        ("FrontL", FRONT_AXLE, tyre_w_front), ("FrontR", FRONT_AXLE, tyre_w_front),
        ("RearL", REAR_AXLE, tyre_w_rear), ("RearR", REAR_AXLE, tyre_w_rear),
    ):
        sign = 1 if label.endswith("L") else -1
        y = sign * (TRACK_HALF + width / 2 - 0.10)
        build_wheel(label, x, y, sign, width, tyre_r, mats, coll, spec, spokes, compound_data)

        # Wishbones sweep inboard-and-back into the tub flank. The inner ends
        # stop AT the bodywork (y_inner), never crossing the centreline —
        # otherwise the arms visibly skewer the nose.
        inner_x = x - 0.58 if x > 0 else x + 0.58
        y_inner = sign * (0.215 if x > 0 else 0.255)
        for k, (z_outer, z_inner) in enumerate(
                ((tyre_r + 0.075, 0.520), (tyre_r - 0.115, 0.285))):
            outer = Vector((x, y, z_outer))
            inner = Vector((inner_x, y_inner, z_inner))
            arm = cylinder(f"PW_Wishbone{label}{k}", 0.026, (inner - outer).length,
                           (outer + inner) / 2, segments=12)
            arm.rotation_mode = "QUATERNION"
            arm.rotation_quaternion = (inner - outer).to_track_quat("Z", "Y")
            finish(arm, mats["carbon"], coll, bevel=0.0)

        # Trackrod / pushrod for a bit of mechanical density.
        outer = Vector((x - sign * 0.0, y * 0.97, tyre_r - 0.02))
        inner = Vector((inner_x + (0.20 if x > 0 else -0.20), y_inner * 0.9, 0.455))
        rod = cylinder(f"PW_Pushrod{label}", 0.019, (inner - outer).length,
                       (outer + inner) / 2, segments=10)
        rod.rotation_mode = "QUATERNION"
        rod.rotation_quaternion = (inner - outer).to_track_quat("Z", "Y")
        finish(rod, mats["carbon_light"], coll, bevel=0.0)

    return {
        "spec": spec["spec"],
        "tiers": spec["tiers"],
        "livery": livery,
        "style": style,
        "compound": compound,
        "rim": rim,
        "objects": len(coll.objects),
    }


# ── Lighting, camera, render ────────────────────────────────────────────────

# (azimuth°, elevation°, lens mm, framing margin)
VIEWS = {
    "three-quarter": (48.0, 20.0, 70.0, 1.22),
    "hero": (34.0, 12.0, 85.0, 1.16),
    "side": (0.0, 2.0, 100.0, 1.10),
    "front": (90.0, 12.0, 80.0, 1.30),
    "rear": (-90.0, 16.0, 80.0, 1.30),
    "top": (40.0, 68.0, 70.0, 1.20),
    # Looks at the front-LEFT wheel from ahead and outboard, so the compound
    # band and rim face are square to camera.
    "wheel": (140.0, 12.0, 85.0, 1.15),
}


def car_bounds():
    coll = bpy.data.collections[COLLECTION]
    bpy.context.view_layer.update()
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for obj in coll.objects:
        if obj.type != "MESH":
            continue
        for corner in obj.bound_box:
            p = obj.matrix_world @ Vector(corner)
            lo = Vector((min(lo[i], p[i]) for i in range(3)))
            hi = Vector((max(hi[i], p[i]) for i in range(3)))
    return lo, hi


def setup_studio(view, transparent, resolution=(1600, 900)):
    scene = bpy.context.scene

    for obj in list(scene.objects):
        if obj.type in {"LIGHT", "CAMERA"} or obj.name.startswith("PW_Studio"):
            bpy.data.objects.remove(obj, do_unlink=True)

    azimuth, elevation, lens, margin = VIEWS.get(view, VIEWS["three-quarter"])
    lo, hi = car_bounds()
    center = (lo + hi) / 2
    size = hi - lo

    cam_data = bpy.data.cameras.new("PW_Cam")
    cam_data.lens = lens
    cam = bpy.data.objects.new("PW_Cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam

    aspect = resolution[0] / resolution[1]
    half_fov_x = math.atan(cam_data.sensor_width / 2 / lens)
    half_fov_y = math.atan(math.tan(half_fov_x) / aspect)

    # Azimuth 0 looks from -Y (side view); 90 looks from +X (front).
    az, el = math.radians(azimuth), math.radians(elevation)
    offset = Vector((math.cos(el) * math.sin(az), -math.cos(el) * math.cos(az), math.sin(el)))

    if view == "wheel":
        # Frame the front-left wheel alone — using the car's bounds here would
        # zoom out to fit the whole car while merely centred on the wheel.
        wheel_y = 0.95
        lo = Vector((FRONT_AXLE - 0.44, wheel_y - 0.40, 0.0))
        hi = Vector((FRONT_AXLE + 0.44, wheel_y + 0.40, 0.78))
        center = (lo + hi) / 2

    # Exact fit: project every bounding-box corner into the camera basis and
    # take the distance that keeps the worst one inside both FOVs. A bounding
    # sphere would push a wide, flat car far too far away.
    forward = -offset.normalized()
    world_up = Vector((0.0, 0.0, 1.0))
    right = forward.cross(world_up)
    right = right.normalized() if right.length > 1e-4 else Vector((1.0, 0.0, 0.0))
    up = right.cross(forward).normalized()

    tan_x, tan_y = math.tan(half_fov_x), math.tan(half_fov_y)
    dist = 3.0
    for cx in (lo.x, hi.x):
        for cy in (lo.y, hi.y):
            for cz in (lo.z, hi.z):
                v = Vector((cx, cy, cz)) - center
                depth = v.dot(forward)
                dist = max(dist,
                           abs(v.dot(right)) * margin / tan_x - depth,
                           abs(v.dot(up)) * margin / tan_y - depth)
    cam.location = center + offset * dist
    cam.rotation_mode = "QUATERNION"
    cam.rotation_quaternion = (center - cam.location).to_track_quat("-Z", "Y")

    def add_light(name, energy, location, size=4.0, rotation=(0, 0, 0), color=(1, 1, 1)):
        data = bpy.data.lights.new(name, "AREA")
        data.energy = energy
        data.color = color
        data.size = size
        obj = bpy.data.objects.new(name, data)
        obj.location = location
        obj.rotation_euler = rotation
        scene.collection.objects.link(obj)

    # Kept deliberately soft: a hot key washes the livery toward white and the
    # whole point is that the paint reads as the team's actual colour.
    # Large, soft emitters: a small area light leaves a hard-edged pool on the
    # ground that reads as a wall behind the car.
    add_light("PW_Key", 700, (5.0, -6.0, 9.0), size=30.0, rotation=(0.62, 0.0, 0.62))
    add_light("PW_Top", 420, (0.0, -0.5, 10.0), size=40.0)
    add_light("PW_Fill", 240, (-6.0, -5.0, 3.6), size=18.0,
              rotation=(1.10, 0.0, -0.85), color=(0.84, 0.90, 1.0))
    add_light("PW_RimLight", 320, (-5.5, 6.0, 3.4), size=14.0,
              rotation=(1.25, 0.0, 3.55), color=(0.90, 1.0, 0.70))

    world = scene.world or bpy.data.worlds.new("PW_World")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value = (0.017, 0.018, 0.022, 1.0)
    bg.inputs["Strength"].default_value = 1.0

    if not transparent:
        ground = box("PW_StudioGround", (120, 120, 0.05), (0, 0, -0.03))
        scene.collection.objects.link(ground)
        ground.data.materials.append(
            material("PW_StudioFloor", (0.035, 0.036, 0.042, 1.0), 0.34, 0.0))

    engines = [e.identifier for e in
               bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    for candidate in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES"):
        if candidate in engines:
            scene.render.engine = candidate
            break
    scene.render.resolution_x, scene.render.resolution_y = resolution
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = transparent
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    if scene.render.engine == "CYCLES":
        scene.cycles.samples = 64
    # Standard, not AgX: AgX desaturates the liveries into pastels.
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    return scene


def parse_args(argv):
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--motor", type=float, default=67)
    p.add_argument("--aero", type=float, default=58)
    p.add_argument("--grip", type=float, default=72)
    p.add_argument("--livery", default="pitwall", choices=sorted(LIVERIES))
    p.add_argument("--style", default=None, choices=["stripe", "flash", "duotone", "split", "bare"])
    p.add_argument("--compound", default="SOFT", choices=sorted(COMPOUNDS))
    p.add_argument("--rim", default="silver", choices=sorted(RIMS))
    p.add_argument("--rim-spokes", dest="rim_spokes", default="multi",
                   choices=sorted(RIM_SPOKES))
    p.add_argument("--render", default="")
    p.add_argument("--view", default="three-quarter")
    p.add_argument("--transparent", action="store_true")
    p.add_argument("--turntable", type=int, default=0,
                   help="Render N frames orbiting the car into --render's directory.")
    p.add_argument("--save", default="")
    p.add_argument("--export-glb", dest="export_glb", default="",
                   help="Write the car as a .glb for the app's 3D viewer.")
    p.add_argument("--width", type=int, default=1600)
    p.add_argument("--height", type=int, default=900)
    return p.parse_args(argv)


def join_by_material():
    """
    Collapse the ~150 part objects into one mesh per material.

    The car is modelled as many small objects, which is right for authoring but
    means one draw call each on the phone. Joining by material takes it to
    about a dozen, and keeps the material names the app recolours by.
    """
    coll = bpy.data.collections[COLLECTION]
    groups: dict[str, list] = {}
    for obj in list(coll.objects):
        if obj.type != "MESH" or not obj.data.materials:
            continue
        groups.setdefault(obj.data.materials[0].name, []).append(obj)

    for name, objs in groups.items():
        # Bake modifiers first: joining discards them otherwise.
        for obj in objs:
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.select_all(action="DESELECT")
            obj.select_set(True)
            for mod in list(obj.modifiers):
                try:
                    bpy.ops.object.modifier_apply(modifier=mod.name)
                except RuntimeError:
                    obj.modifiers.remove(mod)

        if len(objs) == 1:
            objs[0].name = name
            continue

        bpy.ops.object.select_all(action="DESELECT")
        for obj in objs:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        bpy.ops.object.join()
        bpy.context.view_layer.objects.active.name = name

    return len(groups)


def export_glb(path: str):
    """
    Export the car for the in-app 3D viewer.

    Material names are preserved — the app recolours the livery at runtime by
    looking them up by name (PW_Primary, PW_Accent, PW_CompoundBand, PW_Rim,
    …), which is why those names are kept stable.
    """
    merged = join_by_material()
    print(f"[pitwall] merged into {merged} material groups")

    coll = bpy.data.collections[COLLECTION]
    bpy.ops.object.select_all(action="DESELECT")
    for obj in coll.objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = next(iter(coll.objects), None)

    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=False,         # modifiers were already baked in the join
        export_yup=True,            # three.js is Y-up; Blender is Z-up
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
    )
    force_blend_alpha(path, prefix="PW_Decal_")


def force_blend_alpha(path: str, prefix: str):
    """
    Mark the sponsor-ad materials as alpha-blending, in the file.

    A brand can choose to print straight onto the bodywork with no plate
    behind it; that decal's texture carries a transparent background, and an
    OPAQUE material renders the empty area as a solid block covering the paint.
    The Blender material is set to blend, but the glTF exporter decides
    alphaMode from whether the Principled *Alpha* input is actually driven —
    and here the texture only arrives at runtime, in the app, so at export time
    there is nothing for it to see. Rather than fake a driver to satisfy the
    heuristic, the flag is written into the finished file.
    """
    import json
    import pathlib
    import struct

    data = pathlib.Path(path).read_bytes()
    magic, _version, _length = struct.unpack_from("<III", data, 0)
    assert magic == 0x46546C67, "not a GLB"
    json_len, json_type = struct.unpack_from("<II", data, 12)
    assert json_type == 0x4E4F534A, "first chunk is not JSON"
    doc = json.loads(data[20:20 + json_len])

    touched = 0
    for mat in doc.get("materials", []):
        if mat.get("name", "").startswith(prefix):
            mat["alphaMode"] = "BLEND"
            touched += 1

    body = data[20 + json_len:]
    blob = json.dumps(doc, separators=(",", ":")).encode()
    blob += b" " * (-len(blob) % 4)
    head = struct.pack("<III", magic, 2, 12 + 8 + len(blob) + len(body))
    pathlib.Path(path).write_bytes(
        head + struct.pack("<II", len(blob), 0x4E4F534A) + blob + body)
    print(f"[pitwall] alphaMode BLEND on {touched} ad materials")


def main():
    args = parse_args(sys.argv)
    info = build_car(args.motor, args.aero, args.grip, livery=args.livery,
                     compound=args.compound, rim=args.rim, spokes=args.rim_spokes,
                     style=args.style)
    print(f"[pitwall] built {info}")

    if args.turntable:
        # A drag-to-rotate turntable: N stills evenly spaced around the car,
        # all framed identically so the app can flip between them without the
        # car appearing to jump.
        out_dir = args.render or "."
        os.makedirs(out_dir, exist_ok=True)
        scene = setup_studio("hero", True, (args.width, args.height))
        cam = scene.camera
        cam.data.lens = 55.0
        lo, hi = car_bounds()
        center = (lo + hi) / 2

        aspect = args.width / args.height
        half_fov_x = math.atan(cam.data.sensor_width / 2 / cam.data.lens)
        half_fov_y = math.atan(math.tan(half_fov_x) / aspect)
        tan_x, tan_y = math.tan(half_fov_x), math.tan(half_fov_y)
        elevation = math.radians(14.0)

        def orbit_offset(az):
            return Vector((
                math.cos(elevation) * math.sin(az),
                -math.cos(elevation) * math.cos(az),
                math.sin(elevation),
            ))

        # One distance for every frame — the largest any single angle needs.
        # Fitting the bounding SPHERE would be simpler but leaves an elongated
        # car small in frame; projecting the actual corners per angle and
        # taking the maximum keeps the framing tight AND the scale constant, so
        # the car does not pulse as it turns.
        dist = 3.0
        for i in range(args.turntable):
            offset = orbit_offset(2.0 * math.pi * i / args.turntable)
            forward = -offset.normalized()
            right = forward.cross(Vector((0.0, 0.0, 1.0)))
            right = right.normalized() if right.length > 1e-4 else Vector((1.0, 0.0, 0.0))
            up = right.cross(forward).normalized()
            for cx in (lo.x, hi.x):
                for cy in (lo.y, hi.y):
                    for cz in (lo.z, hi.z):
                        v = Vector((cx, cy, cz)) - center
                        depth = v.dot(forward)
                        dist = max(dist,
                                   abs(v.dot(right)) * 1.02 / tan_x - depth,
                                   abs(v.dot(up)) * 1.02 / tan_y - depth)
        for i in range(args.turntable):
            offset = orbit_offset(2.0 * math.pi * i / args.turntable)
            cam.location = center + offset * dist
            cam.rotation_mode = "QUATERNION"
            cam.rotation_quaternion = (center - cam.location).to_track_quat("-Z", "Y")
            path = os.path.join(out_dir, f"frame-{i:02d}.png")
            scene.render.filepath = path
            bpy.ops.render.render(write_still=True)
            print(f"[pitwall] turntable {i + 1}/{args.turntable} -> {path}")
        return

    if args.render:
        setup_studio(args.view, args.transparent, (args.width, args.height))
        bpy.context.scene.render.filepath = args.render
        bpy.ops.render.render(write_still=True)
        print(f"[pitwall] rendered {args.view} -> {args.render}")
    if args.export_glb:
        export_glb(args.export_glb)
        print(f"[pitwall] exported {args.export_glb}")
    if args.save:
        bpy.ops.wm.save_as_mainfile(filepath=args.save)
        print(f"[pitwall] saved {args.save}")


if __name__ == "__main__":
    main()
