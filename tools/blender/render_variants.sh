#!/usr/bin/env bash
# Render the Pit Wall car variants.
#
#   ./render_variants.sh <out-dir> [specs|liveries|compounds|rims|sprites|all]
#
# "sprites" writes the transparent PNGs the mobile app ships: one per
# development spec, plus a wheel close-up per tyre compound.
#
# Renders the stylised 2026 car (build_toon_car.py). Set CAR=classic to use
# the original realistic-proportion builder instead.

set -euo pipefail

BLENDER="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
HERE="$(cd "$(dirname "$0")" && pwd)"
case "${CAR:-toon}" in
  toon)    SCRIPT="$HERE/build_toon_car.py" ;;
  classic) SCRIPT="$HERE/build_f1_car.py" ;;
  *) echo "CAR must be toon or classic" >&2; exit 2 ;;
esac
OUT="${1:?usage: render_variants.sh <out-dir> [group]}"
GROUP="${2:-all}"
mkdir -p "$OUT"

render() { # render <outfile> <extra args...>
  local file="$1"; shift
  "$BLENDER" --background --factory-startup --python "$SCRIPT" -- \
    --render "$file" "$@" 2>&1 | grep -E '^\[pitwall\]|Error|Traceback' || true
}

# Stat values landing mid-tier, plus the wheels each spec ships with.
# Plain case statements: macOS still ships bash 3.2, which has no `declare -A`.
spec_stats() {
  case "$1" in
    C) echo "48 48 48" ;;
    B) echo "64 64 64" ;;
    A) echo "78 78 78" ;;
  esac
}
spec_rim() {
  case "$1" in
    C) echo "graphite blade" ;;
    B) echo "silver multi" ;;
    A) echo "accent turbine" ;;
  esac
}
spec_tyre() {
  case "$1" in
    C) echo "HARD" ;;
    B) echo "MEDIUM" ;;
    A) echo "SOFT" ;;
  esac
}

if [[ "$GROUP" == "specs" || "$GROUP" == "all" ]]; then
  for s in C B A; do
    read -r m a g <<<"$(spec_stats "$s")"
    read -r rim spokes <<<"$(spec_rim "$s")"
    render "$OUT/spec_${s}.png" --motor "$m" --aero "$a" --grip "$g" \
      --rim "$rim" --rim-spokes "$spokes" --compound "$(spec_tyre "$s")" \
      --view hero --width 1300 --height 730
  done
fi

if [[ "$GROUP" == "liveries" || "$GROUP" == "all" ]]; then
  for l in $(python3 -c "import sys; sys.path.insert(0, '$HERE'); import car_config; print(' '.join(car_config.LIVERIES))"); do
    render "$OUT/livery_${l}.png" --livery "$l" --motor 72 --aero 72 --grip 72 \
      --rim accent --rim-spokes turbine --compound SOFT \
      --view hero --width 1000 --height 560
  done
fi

if [[ "$GROUP" == "compounds" || "$GROUP" == "all" ]]; then
  for c in SOFT MEDIUM HARD INTERMEDIATE WET; do
    render "$OUT/tyre_${c}.png" --compound "$c" --motor 72 --aero 72 --grip 72 \
      --rim accent --rim-spokes turbine \
      --view wheel --width 720 --height 720
  done
fi

if [[ "$GROUP" == "rims" || "$GROUP" == "all" ]]; then
  for r in silver graphite gold bronze accent primary white; do
    render "$OUT/rim_${r}.png" --rim "$r" --rim-spokes turbine \
      --motor 72 --aero 72 --grip 72 --compound SOFT \
      --view wheel --width 620 --height 620
  done
fi

# Transparent sprites for the mobile app.
if [[ "$GROUP" == "sprites" || "$GROUP" == "all" ]]; then
  mkdir -p "$OUT/sprites"
  for s in C B A; do
    read -r m a g <<<"$(spec_stats "$s")"
    read -r rim spokes <<<"$(spec_rim "$s")"
    for c in SOFT MEDIUM HARD INTERMEDIATE WET; do
      render "$OUT/sprites/car_${s}_${c}.png" \
        --motor "$m" --aero "$a" --grip "$g" \
        --rim "$rim" --rim-spokes "$spokes" --compound "$c" \
        --view hero --transparent --width 1200 --height 675
    done
  done
fi

echo "done -> $OUT"
