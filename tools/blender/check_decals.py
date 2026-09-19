"""
Pit Wall — sponsor ad audit.

An ad only does its job if it lies ON the panel, at a constant height, over its
whole area. That is a different question from `check_contacts.py`'s: a decal
lying at an angle, half-sunk at one end, is "connected" and still looks broken.

Decals are patches sampled onto the host panel (`build_toon_car.conform_decal`),
so the measurement is per-vertex: how far is each point of the ad from the skin
underneath it? A conforming patch reads as a tight band around the target lift.
A patch that ran off its panel, or landed on the wrong surface, shows up as a
wide spread.

  blender --background --factory-startup --python check_decals.py -- \
      --motor 78 --aero 78 --grip 78
"""

import os
import sys

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_toon_car as toon  # noqa: E402
import build_f1_car as base  # noqa: E402

LIFT_TOL = 0.004          # metres either side of the slot's own target
SPREAD_MAX = 0.006        # max-min across one ad
AREA_TOL = 0.35           # fraction the patch may fall short of its footprint


def host_of(name):
    """The panel an ad rides, read from the table the builder places by."""
    key = name[len("PW_Decal_"):]
    key = key[:-2] if key.endswith("-1") else key[:-1]
    entry = toon.SPONSOR_DECALS.get(key)
    if entry is None:
        return None, None
    _size, _seed, hosts, _mirrored, _surface, _lift, _along = entry
    s = -1 if name.endswith("-1") else 1
    for candidate in hosts.split("|"):
        obj = bpy.data.objects.get(candidate.format(s=s))
        if obj:
            return obj, entry
    return None, entry


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []

    def opt(name, default):
        return float(argv[argv.index(name) + 1]) if name in argv else default

    motor, aero, grip = opt("--motor", 78), opt("--aero", 78), opt("--grip", 78)
    livery = argv[argv.index("--livery") + 1] if "--livery" in argv else "pitwall"
    toon.OUTLINE = False
    spec = toon.build_car(motor, aero, grip, livery=livery)

    coll = bpy.data.collections[base.COLLECTION]
    ads = sorted((o for o in coll.objects if o.name.startswith("PW_Decal_")),
                 key=lambda o: o.name)
    print(f"[decals] spec {spec['spec']} / {livery} — {len(ads)} ads")

    bad = []
    for obj in ads:
        host, entry = host_of(obj.name)
        if host is None:
            bad.append(obj.name)
            print(f"[decals] BAD {obj.name:26s} no host panel")
            continue
        tree = BVHTree.FromPolygons(
            [host.matrix_world @ v.co for v in host.data.vertices],
            [list(p.vertices) for p in host.data.polygons], all_triangles=False)

        mw = obj.matrix_world
        lifts = []
        for v in obj.data.vertices:
            world = mw @ v.co
            hit, _, _, _ = tree.find_nearest(world, 1.0)
            if hit is not None:
                lifts.append((world - hit).length)
        if not lifts:
            bad.append(obj.name)
            continue
        lo, hi = min(lifts), max(lifts)
        spread = hi - lo

        # Did the patch keep its requested footprint, or collapse / get clipped?
        size = entry[0]
        pts = [mw @ v.co for v in obj.data.vertices]
        extent = max((a - b).length for a in pts for b in pts)
        wanted = (size[0] ** 2 + size[1] ** 2) ** 0.5

        problems = []
        target = entry[5]
        if not (target - LIFT_TOL <= lo and hi <= target + LIFT_TOL):
            problems.append(f"lift {lo * 1000:.1f}-{hi * 1000:.1f}mm")
        if spread > SPREAD_MAX:
            problems.append(f"spread {spread * 1000:.1f}mm")
        if extent < wanted * (1 - AREA_TOL):
            problems.append(f"footprint {extent / wanted:.0%}")
        mark = "BAD " if problems else "ok  "
        print(f"[decals] {mark}{obj.name:26s} lift={lo * 1000:4.1f}-{hi * 1000:4.1f}mm "
              f"spread={spread * 1000:4.1f}mm size={extent / wanted:4.0%} "
              + " ".join(problems))
        if problems:
            bad.append(obj.name)

    if bad:
        print(f"[decals] FAIL — {len(bad)} ad(s) badly seated")
        raise SystemExit(1)
    print("[decals] PASS — every ad conforms to its panel")


if __name__ == "__main__":
    main()
