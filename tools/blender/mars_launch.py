"""Mars shuttle launch: dusty liftoff animation, built entirely from Python.

Run headless (no Blender MCP addon needed):
    /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \
        --python tools/blender/mars_launch.py -- --render

Or open in the Blender GUI and just run the script (Scripting tab) to build
the scene, then press Render > Render Animation yourself.

CLI args (all after the `--`):
    --frames N       total frame count (default 150, at 24fps ~ 6.25s)
    --width W        render width (default 960)
    --height H       render height (default 540)
    --samples S      Eevee/Cycles samples (default 32)
    --out PATH       output video path (default tools/blender/out/mars_launch.mp4)
    --save-blend P   also save the built scene as a .blend at P
    --render         actually render the animation (otherwise just builds + saves)
"""
import argparse
import math
import random
import sys
from pathlib import Path

import bpy

random.seed(7)

HERE = Path(__file__).resolve().parent


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--frames", type=int, default=150)
    p.add_argument("--width", type=int, default=960)
    p.add_argument("--height", type=int, default=540)
    p.add_argument("--samples", type=int, default=32)
    p.add_argument("--out", type=str, default=str(HERE / "out" / "mars_launch.mp4"))
    p.add_argument("--save-blend", type=str, default="")
    p.add_argument("--render", action="store_true")
    p.add_argument("--eevee", action="store_true", help="force Eevee instead of Cycles")
    p.add_argument("--no-denoise", action="store_true")
    p.add_argument("--no-motion-blur", action="store_true")
    p.add_argument("--no-dof", action="store_true")
    return p.parse_args(argv)


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def get_fcurves(obj):
    """Blender 4.4+/5.x moved to layered Actions; fall back to walking
    layers/strips/channelbags when the flat `Action.fcurves` is gone."""
    ad = obj.animation_data if hasattr(obj, "animation_data") else None
    if not ad or not ad.action:
        return []
    action = ad.action
    if hasattr(action, "fcurves"):
        return list(action.fcurves)
    fcurves = []
    for layer in action.layers:
        for strip in layer.strips:
            for channelbag in getattr(strip, "channelbags", []):
                fcurves.extend(channelbag.fcurves)
    return fcurves


def new_material(name):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    return mat, mat.node_tree


def set_engine(scene, force_eevee=False):
    order = ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE") if force_eevee else \
        ("CYCLES", "BLENDER_EEVEE_NEXT", "BLENDER_EEVEE")
    for candidate in order:
        try:
            scene.render.engine = candidate
            return candidate
        except TypeError:
            continue
    return scene.render.engine


def enable_gpu(scene):
    prefs = bpy.context.preferences.addons.get("cycles")
    if not prefs:
        return
    cprefs = prefs.preferences
    for backend in ("METAL", "OPTIX", "CUDA", "HIP"):
        try:
            cprefs.compute_device_type = backend
        except TypeError:
            continue
        cprefs.get_devices()
        found = False
        for dev in cprefs.devices:
            if dev.type == backend:
                dev.use = True
                found = True
        if found:
            scene.cycles.device = "GPU"
            return


def build_world():
    world = bpy.data.worlds.new("MarsSky")
    bpy.context.scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()

    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    grad = nt.nodes.new("ShaderNodeTexGradient")
    grad.gradient_type = "LINEAR"
    mapping = nt.nodes.new("ShaderNodeMapping")
    coord = nt.nodes.new("ShaderNodeTexCoord")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = (0.05, 0.02, 0.02, 1.0)
    ramp.color_ramp.elements[1].position = 1.0
    ramp.color_ramp.elements[1].color = (0.62, 0.30, 0.16, 1.0)

    mapping.inputs["Rotation"].default_value = (math.radians(90), 0, 0)
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = (0.006, 0.005, 0.010, 1.0)
    mid = ramp.color_ramp.elements.new(0.78)
    mid.color = (0.22, 0.09, 0.07, 1.0)
    ramp.color_ramp.elements[2].position = 1.0
    ramp.color_ramp.elements[2].color = (0.82, 0.45, 0.25, 1.0)

    haze_noise = nt.nodes.new("ShaderNodeTexNoise")
    haze_noise.inputs["Scale"].default_value = 2.0
    haze_ramp = nt.nodes.new("ShaderNodeValToRGB")
    haze_ramp.color_ramp.elements[0].position = 0.4
    haze_ramp.color_ramp.elements[1].position = 0.6
    haze_mix = nt.nodes.new("ShaderNodeMixRGB")
    haze_mix.blend_type = "MIX"
    haze_mix.inputs["Fac"].default_value = 0.06

    # Sparse stars: Voronoi cell-distance thresholded into points, faded out
    # near the bright dusty horizon (only show against the dark upper sky).
    star_voronoi = nt.nodes.new("ShaderNodeTexVoronoi")
    star_voronoi.inputs["Scale"].default_value = 900.0
    star_thresh = nt.nodes.new("ShaderNodeMath")
    star_thresh.operation = "LESS_THAN"
    star_thresh.inputs[1].default_value = 0.02
    star_twinkle = nt.nodes.new("ShaderNodeTexVoronoi")
    star_twinkle.voronoi_dimensions = "3D"
    star_twinkle.inputs["Scale"].default_value = 900.0
    star_brightness = nt.nodes.new("ShaderNodeMath")
    star_brightness.operation = "MULTIPLY"
    star_brightness.inputs[1].default_value = 9.0
    star_brightness.use_clamp = False
    star_zenith_invert = nt.nodes.new("ShaderNodeMath")
    star_zenith_invert.operation = "SUBTRACT"
    star_zenith_invert.inputs[0].default_value = 1.0
    star_zenith_mask = nt.nodes.new("ShaderNodeMath")
    star_zenith_mask.operation = "MULTIPLY"
    star_final = nt.nodes.new("ShaderNodeCombineColor")
    star_add = nt.nodes.new("ShaderNodeMixRGB")
    star_add.blend_type = "ADD"
    star_add.inputs["Fac"].default_value = 1.0

    nt.links.new(coord.outputs["Generated"], mapping.inputs["Vector"])
    nt.links.new(mapping.outputs["Vector"], grad.inputs["Vector"])
    nt.links.new(grad.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(coord.outputs["Generated"], haze_noise.inputs["Vector"])
    nt.links.new(haze_noise.outputs["Fac"], haze_ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], haze_mix.inputs["Color1"])
    nt.links.new(haze_ramp.outputs["Color"], haze_mix.inputs["Color2"])

    nt.links.new(coord.outputs["Generated"], star_voronoi.inputs["Vector"])
    nt.links.new(star_voronoi.outputs["Distance"], star_thresh.inputs[0])
    nt.links.new(coord.outputs["Generated"], star_twinkle.inputs["Vector"])
    nt.links.new(star_twinkle.outputs["Distance"], star_brightness.inputs[0])
    nt.links.new(grad.outputs["Fac"], star_zenith_invert.inputs[1])
    nt.links.new(star_thresh.outputs["Value"], star_zenith_mask.inputs[0])
    nt.links.new(star_zenith_invert.outputs["Value"], star_zenith_mask.inputs[1])
    star_combine = nt.nodes.new("ShaderNodeMath")
    star_combine.operation = "MULTIPLY"
    nt.links.new(star_zenith_mask.outputs["Value"], star_combine.inputs[0])
    nt.links.new(star_brightness.outputs["Value"], star_combine.inputs[1])
    nt.links.new(star_combine.outputs["Value"], star_final.inputs["Red"])
    nt.links.new(star_combine.outputs["Value"], star_final.inputs["Green"])
    nt.links.new(star_combine.outputs["Value"], star_final.inputs["Blue"])

    nt.links.new(haze_mix.outputs["Color"], star_add.inputs["Color1"])
    nt.links.new(star_final.outputs["Color"], star_add.inputs["Color2"])
    nt.links.new(star_add.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 1.0
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])

    bpy.ops.object.light_add(type="SUN", location=(0, 0, 0))
    sun = bpy.context.object
    sun.name = "MarsSun"
    sun.data.energy = 2.8
    sun.data.angle = math.radians(1.0)
    sun.data.color = (1.0, 0.93, 0.85)
    sun.rotation_euler = (math.radians(55), 0, math.radians(35))
    return sun


def build_ground():
    bpy.ops.mesh.primitive_plane_add(size=400, location=(0, 0, 0))
    ground = bpy.context.object
    ground.name = "MarsGround"

    subsurf = ground.modifiers.new("Subdiv", "SUBSURF")
    subsurf.levels = 5
    subsurf.render_levels = 5

    tex = bpy.data.textures.new("MarsNoise", type="CLOUDS")
    tex.noise_scale = 6.0
    disp = ground.modifiers.new("Bumps", "DISPLACE")
    disp.texture = tex
    disp.strength = 1.4

    mat, nt = new_material("MarsSurface")
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    coord = nt.nodes.new("ShaderNodeTexCoord")

    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 12.0
    noise.inputs["Detail"].default_value = 8.0
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = (0.24, 0.085, 0.04, 1.0)
    mid = ramp.color_ramp.elements.new(0.5)
    mid.color = (0.42, 0.17, 0.08, 1.0)
    ramp.color_ramp.elements[2].color = (0.58, 0.27, 0.13, 1.0)
    nt.links.new(coord.outputs["Object"], noise.inputs["Vector"])
    nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])

    bump_noise = nt.nodes.new("ShaderNodeTexNoise")
    bump_noise.inputs["Scale"].default_value = 40.0
    bump_noise.inputs["Detail"].default_value = 10.0
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.25
    nt.links.new(coord.outputs["Object"], bump_noise.inputs["Vector"])
    nt.links.new(bump_noise.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])

    rough_ramp = nt.nodes.new("ShaderNodeValToRGB")
    rough_ramp.color_ramp.elements[0].position = 0.85
    rough_ramp.color_ramp.elements[0].color = (0.75, 0.75, 0.75, 1.0)
    rough_ramp.color_ramp.elements[1].color = (1.0, 1.0, 1.0, 1.0)
    nt.links.new(noise.outputs["Fac"], rough_ramp.inputs["Fac"])
    nt.links.new(rough_ramp.outputs["Color"], bsdf.inputs["Roughness"])
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    ground.data.materials.append(mat)
    bpy.ops.object.shade_smooth()

    build_rock_scatter(ground)
    return ground


def build_rock_scatter(ground):
    """Scatter a modest number of small rocks near the pad via plain linked
    duplicates. (A HAIR particle system was tried first but evaluating it on
    the subdivided ground mesh stalled indefinitely in headless Cycles --
    plain objects are slower to author but render deterministically.)"""
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.3)
    template = bpy.context.object
    template.name = "ScatterRockTemplate"
    tex = bpy.data.textures.new("RockNoise", type="STUCCI")
    tex.noise_scale = 0.6
    disp = template.modifiers.new("Craggy", "DISPLACE")
    disp.texture = tex
    disp.strength = 0.4
    bpy.ops.object.shade_flat()

    mat, nt = new_material("RockMat")
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = (0.22, 0.09, 0.05, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.9
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    template.data.materials.append(mat)
    template.hide_render = True
    template.hide_viewport = True

    rocks = []
    for i in range(60):
        ang = random.uniform(0, 2 * math.pi)
        r = random.uniform(4.0, 60.0)
        rock = bpy.data.objects.new(f"Rock_{i}", template.data)
        bpy.context.collection.objects.link(rock)
        rock.location = (math.cos(ang) * r, math.sin(ang) * r, 0.0)
        s = random.uniform(0.4, 1.6)
        rock.scale = (s, s, s * random.uniform(0.6, 1.1))
        rock.rotation_euler = (0, 0, random.uniform(0, 2 * math.pi))
        rocks.append(rock)
    return rocks


def build_shuttle():
    parts = []

    bpy.ops.mesh.primitive_cylinder_add(radius=1.0, depth=8.0, location=(0, 0, 4.0 + 0.4))
    body = bpy.context.object
    body.name = "ShuttleBody"
    parts.append(body)

    bpy.ops.mesh.primitive_cone_add(radius1=1.0, depth=2.4, location=(0, 0, 8.0 + 1.2 + 0.4))
    nose = bpy.context.object
    parts.append(nose)

    for i in range(3):
        ang = math.radians(120 * i)
        x, y = math.cos(ang) * 1.0, math.sin(ang) * 1.0
        bpy.ops.mesh.primitive_cone_add(
            radius1=0.55, depth=2.2, location=(x, y, 1.5),
            rotation=(math.radians(25) * math.cos(ang + math.pi / 2),
                      math.radians(25) * math.sin(ang + math.pi / 2), ang),
        )
        fin = bpy.context.object
        fin.scale = (0.25, 0.9, 1.0)
        parts.append(fin)

    boosters = []
    for side in (-1, 1):
        bpy.ops.mesh.primitive_cylinder_add(
            radius=0.4, depth=6.0, location=(side * 1.5, 0, 3.0 + 0.4)
        )
        b = bpy.context.object
        parts.append(b)
        boosters.append(b)
        bpy.ops.mesh.primitive_cone_add(
            radius1=0.4, depth=0.8, location=(side * 1.5, 0, 6.0 + 0.4)
        )
        parts.append(bpy.context.object)

    nozzle_parts = []
    bpy.ops.mesh.primitive_cone_add(radius1=0.75, radius2=1.0, depth=0.9, location=(0, 0, 0.05))
    nozzle_parts.append(bpy.context.object)
    for side in (-1, 1):
        bpy.ops.mesh.primitive_cone_add(radius1=0.3, radius2=0.4, depth=0.7, location=(side * 1.5, 0, -0.05))
        nozzle_parts.append(bpy.context.object)
    parts.extend(nozzle_parts)

    bpy.ops.object.select_all(action="DESELECT")
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    shuttle = bpy.context.object
    shuttle.name = "Shuttle"
    bpy.ops.object.origin_set(type="ORIGIN_CURSOR", center="MEDIAN")
    bpy.context.scene.cursor.location = (0, 0, 0)
    bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
    bpy.ops.object.shade_smooth()

    mat, nt = new_material("ShuttleHull")
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    coord = nt.nodes.new("ShaderNodeTexCoord")
    weather = nt.nodes.new("ShaderNodeTexNoise")
    weather.inputs["Scale"].default_value = 18.0
    weather.inputs["Detail"].default_value = 6.0
    weather_ramp = nt.nodes.new("ShaderNodeValToRGB")
    weather_ramp.color_ramp.elements[0].color = (0.78, 0.79, 0.81, 1.0)
    weather_ramp.color_ramp.elements[1].color = (0.92, 0.93, 0.95, 1.0)
    nt.links.new(coord.outputs["Object"], weather.inputs["Vector"])
    nt.links.new(weather.outputs["Fac"], weather_ramp.inputs["Fac"])
    nt.links.new(weather_ramp.outputs["Color"], bsdf.inputs["Base Color"])
    rough_ramp = nt.nodes.new("ShaderNodeValToRGB")
    rough_ramp.color_ramp.elements[0].color = (0.15, 0.15, 0.15, 1.0)
    rough_ramp.color_ramp.elements[1].color = (0.5, 0.5, 0.5, 1.0)
    nt.links.new(weather.outputs["Fac"], rough_ramp.inputs["Fac"])
    nt.links.new(rough_ramp.outputs["Color"], bsdf.inputs["Roughness"])
    bsdf.inputs["Metallic"].default_value = 0.15
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    shuttle.data.materials.append(mat)

    dark_mat, dnt = new_material("EngineDark")
    dnt.nodes.clear()
    dout = dnt.nodes.new("ShaderNodeOutputMaterial")
    dbsdf = dnt.nodes.new("ShaderNodeBsdfPrincipled")
    dbsdf.inputs["Base Color"].default_value = (0.04, 0.035, 0.035, 1.0)
    dbsdf.inputs["Roughness"].default_value = 0.3
    dbsdf.inputs["Metallic"].default_value = 0.8
    dnt.links.new(dbsdf.outputs["BSDF"], dout.inputs["Surface"])
    shuttle.data.materials.append(dark_mat)
    nozzle_idx = len(shuttle.data.materials) - 1
    for poly in shuttle.data.polygons:
        if poly.center.z < 0.5:
            poly.material_index = nozzle_idx

    return shuttle


def _flame_material(name, inner_color, outer_color, strength, noise_scale):
    mat, nt = new_material(name)
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    emit = nt.nodes.new("ShaderNodeEmission")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = inner_color
    ramp.color_ramp.elements[1].color = outer_color
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = noise_scale
    fresnel = nt.nodes.new("ShaderNodeLayerWeight")
    fresnel.inputs["Blend"].default_value = 0.55
    combine = nt.nodes.new("ShaderNodeMixRGB")
    combine.blend_type = "MULTIPLY"
    nt.links.new(noise.outputs["Fac"], combine.inputs["Color1"])
    nt.links.new(fresnel.outputs["Facing"], combine.inputs["Fac"])
    combine.inputs["Color2"].default_value = (1, 1, 1, 1)
    nt.links.new(combine.outputs["Color"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], emit.inputs["Color"])
    emit.inputs["Strength"].default_value = strength
    nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])
    return mat, emit


def build_flame(parent):
    bpy.ops.mesh.primitive_cone_add(radius1=0.55, depth=3.6, location=(0, 0, -1.8))
    core = bpy.context.object
    core.name = "EngineFlameCore"
    core.rotation_euler = (math.radians(180), 0, 0)
    core.parent = parent
    core.location = (0, 0, 0.3)
    core_mat, core_emit = _flame_material(
        "FlameCore", (1.0, 0.9, 0.5, 1.0), (1.0, 0.55, 0.15, 1.0), 30.0, 4.0
    )
    core.data.materials.append(core_mat)

    bpy.ops.mesh.primitive_cone_add(radius1=1.1, depth=2.4, location=(0, 0, -1.2))
    flame = bpy.context.object
    flame.name = "EngineFlame"
    flame.rotation_euler = (math.radians(180), 0, 0)
    flame.parent = parent
    flame.location = (0, 0, 0.3)
    mat, emit = _flame_material(
        "FlameEmission", (0.85, 0.12, 0.02, 1.0), (1.0, 0.7, 0.25, 1.0), 14.0, 2.2
    )
    mat.blend_method = "BLEND"
    flame.data.materials.append(mat)

    glow = bpy.data.lights.new("FlameGlow", type="POINT")
    glow.energy = 4000
    glow.color = (1.0, 0.5, 0.2)
    glow_obj = bpy.data.objects.new("FlameGlow", glow)
    bpy.context.collection.objects.link(glow_obj)
    glow_obj.parent = parent
    glow_obj.location = (0, 0, -1.0)

    return core, flame, core_emit, emit, glow_obj


def make_dust_puff(index, pos, scale0):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3, radius=1.0, location=pos)
    puff = bpy.context.object
    puff.name = f"DustPuff_{index}"

    tex = bpy.data.textures.new(f"PuffNoise{index}", type="CLOUDS")
    tex.noise_scale = 0.9
    tex.noise_depth = 3
    disp = puff.modifiers.new("Puff", "DISPLACE")
    disp.texture = tex
    disp.strength = 0.7

    subsurf = puff.modifiers.new("Smooth", "SUBSURF")
    subsurf.levels = 1
    subsurf.render_levels = 1

    mat, nt = new_material(f"DustMat_{index}")
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    fac = 0.75 + 0.3 * random.random()
    bsdf.inputs["Base Color"].default_value = (0.66 * fac, 0.44 * fac, 0.27 * fac, 1.0)
    bsdf.inputs["Roughness"].default_value = 1.0

    fresnel = nt.nodes.new("ShaderNodeLayerWeight")
    fresnel.inputs["Blend"].default_value = 0.65
    edge_ramp = nt.nodes.new("ShaderNodeValToRGB")
    edge_ramp.color_ramp.elements[0].position = 0.15
    edge_ramp.color_ramp.elements[0].color = (1, 1, 1, 1)
    edge_ramp.color_ramp.elements[1].position = 0.85
    edge_ramp.color_ramp.elements[1].color = (0, 0, 0, 1)
    alpha_mult = nt.nodes.new("ShaderNodeMath")
    alpha_mult.operation = "MULTIPLY"
    alpha_mult.inputs[1].default_value = 0.4
    nt.links.new(fresnel.outputs["Facing"], edge_ramp.inputs["Fac"])
    nt.links.new(edge_ramp.outputs["Color"], alpha_mult.inputs[0])
    if "Alpha" in bsdf.inputs:
        nt.links.new(alpha_mult.outputs["Value"], bsdf.inputs["Alpha"])
    mat.blend_method = "HASHED"
    mat.show_transparent_back = False
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    puff.data.materials.append(mat)
    bpy.ops.object.shade_smooth()

    puff.scale = (scale0, scale0, scale0)
    return puff, alpha_mult


def keyframe_liftoff(shuttle, frames):
    ignition_frame = int(frames * 0.12)
    liftoff_frame = int(frames * 0.22)

    shuttle.location = (0, 0, 0)
    shuttle.keyframe_insert("location", frame=1)
    shuttle.keyframe_insert("location", frame=liftoff_frame)

    mid_frame = int(frames * 0.55)
    shuttle.location = (0, 0, 22)
    shuttle.keyframe_insert("location", frame=mid_frame)

    shuttle.location = (0, 0, 220)
    shuttle.keyframe_insert("location", frame=frames)

    for fcurve in get_fcurves(shuttle):
        if fcurve.data_path == "location" and fcurve.array_index == 2:
            for kp in fcurve.keyframe_points:
                kp.interpolation = "BEZIER"
            fcurve.keyframe_points[0].easing = "EASE_IN"
            fcurve.keyframe_points[1].easing = "EASE_IN"
            fcurve.keyframe_points[-1].easing = "EASE_OUT"

    for f in range(1, liftoff_frame):
        rot = (math.radians(random.uniform(-1.2, 1.2)),
               math.radians(random.uniform(-1.2, 1.2)), 0)
        shuttle.rotation_euler = rot
        shuttle.keyframe_insert("rotation_euler", frame=f)
    shuttle.rotation_euler = (0, 0, 0)
    shuttle.keyframe_insert("rotation_euler", frame=liftoff_frame + 5)

    return ignition_frame, liftoff_frame


def keyframe_flame(core, flame, core_emit, emit_node, glow_obj, ignition_frame, end_frame):
    for obj in (core, flame):
        obj.scale = (0.01, 0.01, 0.01)
        obj.keyframe_insert("scale", frame=ignition_frame - 3)
    for node in (core_emit, emit_node):
        node.inputs["Strength"].default_value = 0.0
        node.inputs["Strength"].keyframe_insert("default_value", frame=ignition_frame - 3)
    glow_obj.data.energy = 0.0
    glow_obj.data.keyframe_insert("energy", frame=ignition_frame - 3)

    for f in range(ignition_frame, end_frame, 3):
        jitter = random.uniform(0.85, 1.15)
        core.scale = (0.75 * jitter, 0.75 * jitter, 1.0 * jitter)
        core.keyframe_insert("scale", frame=f)
        flame.scale = (0.85 * jitter, 0.85 * jitter, 1.15 * jitter)
        flame.keyframe_insert("scale", frame=f)
        core_emit.inputs["Strength"].default_value = random.uniform(24, 36)
        core_emit.inputs["Strength"].keyframe_insert("default_value", frame=f)
        emit_node.inputs["Strength"].default_value = random.uniform(10, 18)
        emit_node.inputs["Strength"].keyframe_insert("default_value", frame=f)
        glow_obj.data.energy = random.uniform(3000, 5500)
        glow_obj.data.keyframe_insert("energy", frame=f)

    for obj in (core, flame):
        for fcurve in get_fcurves(obj):
            for kp in fcurve.keyframe_points:
                kp.interpolation = "LINEAR"


def keyframe_dust(puff, alpha_mult, start, peak, end, final_scale):
    alpha_in = alpha_mult.inputs[1]
    puff.scale = (0.05, 0.05, 0.05)
    puff.keyframe_insert("scale", frame=start)
    alpha_in.default_value = 0.0
    alpha_in.keyframe_insert("default_value", frame=start)
    puff.keyframe_insert("location", frame=start)

    puff.scale = (final_scale, final_scale, final_scale * 0.6)
    puff.keyframe_insert("scale", frame=peak)
    alpha_in.default_value = 0.4
    alpha_in.keyframe_insert("default_value", frame=peak)

    drift = random.uniform(0.3, 1.2)
    puff.location = (puff.location.x, puff.location.y, puff.location.z + drift)
    puff.keyframe_insert("location", frame=end)

    puff.scale = (final_scale * 1.6, final_scale * 1.6, final_scale * 0.7)
    puff.keyframe_insert("scale", frame=end)
    alpha_in.default_value = 0.0
    alpha_in.keyframe_insert("default_value", frame=end)


def build_camera(shuttle, frames, use_dof=True):
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0, 0, 5.5))
    target = bpy.context.object
    target.name = "CamTarget"
    target.parent = shuttle
    target.location = (0, 0, 5.5)

    bpy.ops.object.camera_add(location=(26, -32, 10))
    cam = bpy.context.object
    cam.name = "LaunchCam"
    cam.data.lens = 35
    if use_dof:
        cam.data.dof.use_dof = True
        cam.data.dof.focus_object = target
        cam.data.dof.aperture_fstop = 16.0
    bpy.context.scene.camera = cam

    track = cam.constraints.new("TRACK_TO")
    track.target = target
    track.track_axis = "TRACK_NEGATIVE_Z"
    track.up_axis = "UP_Y"

    cam.location = (26, -32, 10)
    cam.keyframe_insert("location", frame=1)
    cam.location = (34, -42, 20)
    cam.keyframe_insert("location", frame=int(frames * 0.5))
    cam.location = (48, -58, 38)
    cam.keyframe_insert("location", frame=frames)

    for fcurve in get_fcurves(cam):
        for kp in fcurve.keyframe_points:
            kp.interpolation = "BEZIER"
    return cam


def main():
    args = parse_args()
    clear_scene()
    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = args.frames
    scene.render.fps = 24

    engine = set_engine(scene, force_eevee=args.eevee)
    scene.render.resolution_x = args.width
    scene.render.resolution_y = args.height
    if hasattr(scene, "eevee"):
        try:
            scene.eevee.taa_render_samples = args.samples
        except AttributeError:
            pass
    if engine == "CYCLES":
        enable_gpu(scene)
        scene.cycles.samples = args.samples
        scene.cycles.use_denoising = not args.no_denoise
        scene.cycles.use_adaptive_sampling = True
        scene.render.use_motion_blur = not args.no_motion_blur
        scene.render.motion_blur_position = "START"
        scene.render.motion_blur_shutter = 0.4


    build_world()
    build_ground()
    shuttle = build_shuttle()
    ignition_frame, liftoff_frame = keyframe_liftoff(shuttle, args.frames)

    core, flame, core_emit, emit_node, glow_obj = build_flame(shuttle)
    keyframe_flame(core, flame, core_emit, emit_node, glow_obj, ignition_frame, args.frames)

    n_puffs = 14
    for i in range(n_puffs):
        ang = (2 * math.pi / n_puffs) * i + random.uniform(-0.35, 0.35)
        r = random.uniform(2.5, 7.0)
        pos = (math.cos(ang) * r, math.sin(ang) * r, 0.2)
        puff, bsdf = make_dust_puff(i, pos, 0.05)
        start = ignition_frame + random.randint(-2, 5)
        peak = liftoff_frame + random.randint(10, 28)
        end = min(args.frames, peak + random.randint(35, 70))
        keyframe_dust(puff, bsdf, start, peak, end, random.uniform(2.5, 4.5))

    build_camera(shuttle, args.frames, use_dof=not args.no_dof)

    out_path = Path(args.out)
    frames_dir = out_path.parent / f"{out_path.stem}_frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(frames_dir) + "/frame_"

    if args.save_blend:
        blend_path = Path(args.save_blend)
        blend_path.parent.mkdir(parents=True, exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))
        print(f"[pitwall] saved blend -> {blend_path}")

    if args.render:
        print(f"[pitwall] rendering {args.frames} frames with {engine} -> {frames_dir}")
        bpy.ops.render.render(animation=True)
        print(f"[pitwall] rendered frames -> {frames_dir}")
        print(f"[pitwall] MUX_CMD ffmpeg -y -framerate {scene.render.fps} -i "
              f"{frames_dir}/frame_%04d.png -pix_fmt yuv420p {out_path}")
    else:
        print("[pitwall] scene built (no --render passed, skipped rendering)")


if __name__ == "__main__":
    main()
