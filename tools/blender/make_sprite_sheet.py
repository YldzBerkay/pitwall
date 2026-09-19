#!/usr/bin/env python3
"""
Pack turntable frames into a single sprite sheet for the app.

The app shows the car by moving one texture behind a clipping view. That needs
the frames as one image: stacking a separate <Image> per frame makes the
compositor blend every layer each frame, which stutters on device.

Frames are cropped to the UNION of every frame's alpha bounds before packing.
Blender's turntable framing has to satisfy the worst angle on both axes, which
leaves dead margin on the other — around 25% of each axis in practice. Cropping
all frames to one shared rectangle reclaims those pixels for the car itself
(sharper at the same texture budget) without the car shifting between frames,
which a per-frame crop would cause.

  python3 make_sprite_sheet.py <frames-dir> <out.png> [cols]

Keep `cols` such that the sheet stays within 4096px on both axes. Every iOS
device Expo supports handles 4096; going beyond that risks older GPUs.
"""
import os
import sys

from PIL import Image

# Kept so the car never touches the cell edge, in fractions of the crop size.
PAD_FRACTION = 0.01


def union_alpha_bbox(frames):
    """Smallest rectangle containing the car in EVERY frame."""
    x0 = y0 = 10**9
    x1 = y1 = -1
    for frame in frames:
        mask = frame.getchannel("A").point(lambda v: 255 if v > 8 else 0)
        box = mask.getbbox()
        if box is None:
            continue
        x0, y0 = min(x0, box[0]), min(y0, box[1])
        x1, y1 = max(x1, box[2]), max(y1, box[3])
    if x1 < 0:
        return None
    return x0, y0, x1, y1


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    src, out = sys.argv[1], sys.argv[2]
    cols = int(sys.argv[3]) if len(sys.argv) > 3 else 4

    files = sorted(f for f in os.listdir(src) if f.endswith(".png"))
    if not files:
        raise SystemExit(f"no frames in {src}")

    frames = [Image.open(os.path.join(src, f)).convert("RGBA") for f in files]
    source_w, source_h = frames[0].size

    box = union_alpha_bbox(frames)
    if box:
        pad_x = int((box[2] - box[0]) * PAD_FRACTION)
        pad_y = int((box[3] - box[1]) * PAD_FRACTION)
        box = (
            max(0, box[0] - pad_x),
            max(0, box[1] - pad_y),
            min(source_w, box[2] + pad_x),
            min(source_h, box[3] + pad_y),
        )
        frames = [f.crop(box) for f in frames]

    w, h = frames[0].size
    rows = (len(frames) + cols - 1) // cols

    sheet = Image.new("RGBA", (w * cols, h * rows), (0, 0, 0, 0))
    for i, frame in enumerate(frames):
        sheet.paste(frame, ((i % cols) * w, (i // cols) * h))

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    sheet.save(out, optimize=True)

    reclaimed = 100 - (w * h) / (source_w * source_h) * 100
    print(f"frames={len(frames)} source={source_w}x{source_h} cell={w}x{h} "
          f"(cropped {reclaimed:.0f}% of area) grid={cols}x{rows} "
          f"sheet={sheet.width}x{sheet.height} kb={os.path.getsize(out) // 1024}")
    print(f"  aspect for CELL_ASPECT: {w / h:.4f}")
    if max(sheet.size) > 4096:
        print(f"  warning: {max(sheet.size)}px exceeds the safe 4096px texture size")


if __name__ == "__main__":
    main()
