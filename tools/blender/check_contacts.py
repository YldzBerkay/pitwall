"""
Pit Wall — "is anything floating?" check.

Builds the car for a development spec and asks, for every mesh in the
collection, whether it is joined to any other one. A part hanging in open air
fails the build instead of waiting to be spotted in a render — which is how
the detached wing pylons and mid-air suspension arms got shipped in the first
place.

Touching one neighbour is not enough: two parts can hold on to each other and
float away as a pair. So contacts are collected into a graph and every part
has to be reachable from the monocoque — a cluster with no path to the
chassis is reported as floating even if its members touch each other.

"Joined" is decided in three steps, because distance alone is the wrong
question:

1. **Surfaces intersect** (`BVHTree.overlap`) — the normal case. Almost every
   part on this car is modelled sunk into its neighbour, and for two meshes
   that pass through each other a vertex-to-surface distance is NOT zero: it
   is the distance from that vertex to the other's skin, which for a mirror
   sunk into its stalk reads as a healthy 10 mm "gap". The first version of
   this script measured exactly that and cried wolf 25 times.
2. **One is inside the other** — a part can be fully enclosed and perfectly
   well attached (the airbox mouth inside the sidepod). Decided by ray
   parity: an odd number of surface crossings along +X means inside.
3. **Otherwise** the closest surface-to-surface distance is the gap, and
   anything over GAP_LIMIT is reported.

  blender --background --factory-startup --python check_contacts.py -- \
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

# Parts closer than this to a neighbour read as touching: it is under the ink
# outline's own thickness, so the join is covered from every angle.
GAP_LIMIT = 0.006

# Parts that are MEANT to sit clear, with the reason. Nothing else gets a pass.
EXPECTED_FREE = {
    # An emissive ring floating in the exhaust mouth; it is the glow, not a part.
    "PW_ExhaustTip",
}

# Sponsor ads are held deliberately clear of the panel — far enough to sit on
# TOP of the livery, whose stripes are themselves geometry standing 14 mm proud
# of the body. Loosening GAP_LIMIT to let them pass would also let a genuinely
# detached part through, so they are excluded here and checked properly by
# check_decals.py, which measures each ad's lift against its own slot's target.
EXPECTED_FREE_PREFIXES = ("PW_Decal_",)


def exempt(name):
    return name in EXPECTED_FREE or name.startswith(EXPECTED_FREE_PREFIXES)


def world_geometry(obj):
    """(vertices, polygons) in world space. Modifiers stay off on purpose —
    the ink outline is an inflated hull that would paper over a real gap."""
    mw = obj.matrix_world
    return ([mw @ v.co for v in obj.data.vertices],
            [list(p.vertices) for p in obj.data.polygons])


def inside(tree, point):
    """Ray parity along +X: odd number of crossings means the point is enclosed."""
    origin, crossings = Vector(point), 0
    direction = Vector((1.0, 0.0, 0.0))
    for _ in range(64):
        hit = tree.ray_cast(origin, direction, 50.0)
        if hit[0] is None:
            break
        crossings += 1
        origin = hit[0] + direction * 1e-4
    return crossings % 2 == 1


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []

    def opt(name, default):
        return float(argv[argv.index(name) + 1]) if name in argv else default

    motor, aero, grip = opt("--motor", 78), opt("--aero", 78), opt("--grip", 78)
    livery = argv[argv.index("--livery") + 1] if "--livery" in argv else "pitwall"
    toon.OUTLINE = False
    # Livery matters: the stripe/flash/split treatments add real geometry, so a
    # check that only ever ran the default paint scheme never saw the pod
    # stripes at all.
    spec = toon.build_car(motor, aero, grip, livery=livery)

    coll = bpy.data.collections[base.COLLECTION]
    objs = [o for o in coll.objects if o.type == "MESH" and len(o.data.polygons)]
    geom = {o.name: world_geometry(o) for o in objs}
    trees = {n: BVHTree.FromPolygons(v, p, all_triangles=False)
             for n, (v, p) in geom.items()}

    boxes = {}
    for o in objs:
        vs = geom[o.name][0]
        lo = Vector((min(v[i] for v in vs) for i in range(3)))
        hi = Vector((max(v[i] for v in vs) for i in range(3)))
        boxes[o.name] = (lo, hi)

    def boxes_apart(a, b):
        (alo, ahi), (blo, bhi) = boxes[a], boxes[b]
        return any(ahi[i] + GAP_LIMIT < blo[i] or bhi[i] + GAP_LIMIT < alo[i]
                   for i in range(3))

    parent = {o.name: o.name for o in objs}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    best = {o.name: (1e9, None) for o in objs}
    names = [o.name for o in objs]
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            if boxes_apart(a, b):
                continue
            if trees[a].overlap(trees[b]) or inside(trees[b], geom[a][0][0]) \
                    or inside(trees[a], geom[b][0][0]):
                d = 0.0
            else:
                d = 1e9
                for co in geom[a][0]:
                    hit = trees[b].find_nearest(co, 0.4)
                    if hit[0] is not None:
                        d = min(d, (hit[0] - co).length)
                for co in geom[b][0]:
                    hit = trees[a].find_nearest(co, 0.4)
                    if hit[0] is not None:
                        d = min(d, (hit[0] - co).length)
            if d < best[a][0]:
                best[a] = (d, b)
            if d < best[b][0]:
                best[b] = (d, a)
            if d <= GAP_LIMIT:
                union(a, b)

    root = find("PW_Monocoque")
    detached = sorted(
        ((best[n][0], n, best[n][1]) for n in names
         if find(n) != root and not exempt(n)),
        reverse=True,
    )
    print(f"[contacts] spec {spec['spec']} / {livery} — {len(objs)} parts, "
          f"motor={motor:.0f} aero={aero:.0f} grip={grip:.0f}")
    if detached:
        clusters = {}
        for gap, name, partner in detached:
            clusters.setdefault(find(name), []).append((gap, name, partner))
        for members in clusters.values():
            gap, name, partner = members[0]
            print(f"[contacts] FLOATING cluster of {len(members):2d}: {name} "
                  f"(gap={gap * 1000:.1f} mm, nearest={partner})")
            for _, other, _ in members[1:]:
                print(f"[contacts]              + {other}")
        print(f"[contacts] FAIL — {len(detached)} part(s) not connected to the chassis")
        raise SystemExit(1)
    worst = max((best[n][0], n, best[n][1]) for n in names)
    print(f"[contacts] PASS — all {len(names)} parts connected to PW_Monocoque "
          f"(widest join: {worst[1]} ↔ {worst[2]} at {worst[0] * 1000:.1f} mm)")


if __name__ == "__main__":
    main()
