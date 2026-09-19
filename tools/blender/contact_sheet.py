#!/usr/bin/env python3
"""
Tile rendered variants into one labelled contact sheet, so a whole set of
liveries / compounds / specs can be reviewed in a single image.

  python3 contact_sheet.py out.png 3 img1.png img2.png ...
"""
import sys
from PIL import Image, ImageDraw

BG = (11, 12, 15)
LABEL = (154, 156, 159)


def main():
    out, cols = sys.argv[1], int(sys.argv[2])
    paths = sys.argv[3:]
    if not paths:
        raise SystemExit("no input images")

    tiles = []
    for p in paths:
        img = Image.open(p).convert("RGB")
        tiles.append((p.rsplit("/", 1)[-1].rsplit(".", 1)[0], img))

    tw = max(i.width for _, i in tiles)
    th = max(i.height for _, i in tiles)
    scale = min(1.0, 620 / tw)
    tw, th = int(tw * scale), int(th * scale)
    pad, bar = 8, 20

    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (tw + pad) + pad,
                              rows * (th + bar + pad) + pad), BG)
    draw = ImageDraw.Draw(sheet)

    for idx, (name, img) in enumerate(tiles):
        r, c = divmod(idx, cols)
        x = pad + c * (tw + pad)
        y = pad + r * (th + bar + pad)
        sheet.paste(img.resize((tw, th), Image.LANCZOS), (x, y))
        draw.text((x + 4, y + th + 4), name, fill=LABEL)

    sheet.save(out)
    print(f"wrote {out} ({sheet.width}x{sheet.height}, {len(tiles)} tiles)")


if __name__ == "__main__":
    main()
