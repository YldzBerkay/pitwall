#!/usr/bin/env bash
# Quick three-view preview of the stylised car + a stacked contact sheet.
#   ./preview_toon.sh [out-dir]
set -euo pipefail
BLENDER="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/out/toon}"
mkdir -p "$OUT"

render() { # render <view> <w> <h> <livery> <compound>
  "$BLENDER" --background --factory-startup --python "$HERE/build_toon_car.py" -- \
    --motor 72 --aero 72 --grip 72 --rim accent --rim-spokes multi \
    --livery "$4" --compound "$5" --view "$1" --width "$2" --height "$3" \
    --render "$OUT/$1.png" 2>&1 | grep -E '^\[pitwall\] rendered|Error|Traceback' || true
}

render hero 1400 800 midnight MEDIUM
render side 1400 600 pitwall SOFT
render front 1000 700 pitwall SOFT

python3 - "$OUT" <<'EOF'
import sys
from PIL import Image
out = sys.argv[1]
ims = [Image.open(f"{out}/{n}.png").convert("RGB") for n in ("hero", "side", "front")]
w = 1400
rows = [i.resize((w, int(i.height * w / i.width))) for i in ims]
sheet = Image.new("RGB", (w, sum(r.height for r in rows)))
y = 0
for r in rows:
    sheet.paste(r, (0, y)); y += r.height
sheet.save(f"{out}/sheet.png")
print("sheet ->", f"{out}/sheet.png")
EOF
