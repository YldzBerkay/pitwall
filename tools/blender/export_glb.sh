#!/usr/bin/env bash
# Export the three per-spec .glb models the app's real-time 3D viewer uses:
#   mobile/assets/car/f1-car-{C,B,A}.glb
#
# Outline is OFF (--no-outline): the ink-line trick bakes a second material
# slot onto the same mesh via a Solidify modifier, which makes the glTF
# export split into two primitives per mesh in an order react-native-filament
# doesn't guarantee — recolouring `getMaterialInstanceAt(entity, 0)` could hit
# the outline material instead of the paint. Dropping it keeps every material
# index predictable. The stylised look still comes from the toy proportions,
# glossy clear-coat and bright rim/fill lighting; only the drawn ink line is
# gone. Revisit with a real-time fresnel/rim shader if the outline is missed.
set -euo pipefail
BLENDER="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ASSETS="$HERE/../../mobile/assets/car"

export1() { # export1 <spec> <motor aero grip> <rim> <spokes> <compound>
  local spec="$1" m="$2" a="$3" g="$4" rim="$5" spokes="$6" compound="$7"
  "$BLENDER" --background --factory-startup --python "$HERE/build_toon_car.py" -- \
    --no-outline --livery pitwall --compound "$compound" --rim "$rim" --rim-spokes "$spokes" \
    --motor "$m" --aero "$a" --grip "$g" \
    --export-glb "$ASSETS/f1-car-$spec.glb" \
    2>&1 | grep -E '^\[pitwall\] (built|merged|exported)|Error|Traceback' || true
}

export1 C 48 48 48 graphite blade HARD
export1 B 64 64 64 silver   multi MEDIUM
export1 A 78 78 78 accent   turbine SOFT
ls -la "$ASSETS"/f1-car-*.glb
