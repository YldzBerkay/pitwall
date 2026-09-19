#!/usr/bin/env bash
# Render the three per-spec turntable sprite sheets the app ships:
#   mobile/assets/car/turntable_{C,B,A}.png
# Stats land mid-tier so every part of that tier is fitted, and each spec
# runs the wheels render_variants.sh gives it, so the two stay in step.
set -euo pipefail
BLENDER="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ASSETS="$HERE/../../mobile/assets/car"
TMP="${TMPDIR:-/tmp}/pitwall-turntable"

render() { # render <spec> <motor aero grip> <rim> <spokes> <compound>
  local spec="$1" m="$2" a="$3" g="$4" rim="$5" spokes="$6" compound="$7"
  rm -rf "$TMP/$spec"; mkdir -p "$TMP/$spec"
  "$BLENDER" --background --factory-startup --python "$HERE/build_toon_car.py" -- \
    --livery pitwall --compound "$compound" --rim "$rim" --rim-spokes "$spokes" \
    --motor "$m" --aero "$a" --grip "$g" \
    --turntable 24 --render "$TMP/$spec" --width 1280 --height 544 \
    2>&1 | grep -E 'turntable 24/|Error|Traceback' || true
  python3 "$HERE/make_sprite_sheet.py" "$TMP/$spec" "$ASSETS/turntable_$spec.png" 4
}

render C 48 48 48 graphite blade HARD
render B 64 64 64 silver   multi MEDIUM
render A 78 78 78 accent   turbine SOFT
