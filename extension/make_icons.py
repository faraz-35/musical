#!/usr/bin/env python3
"""Generate musical extension icons.

Design: a rounded-square blue tile (brand accent #4a9dff) with a white
eighth-note + three subtitle lines — i.e. "songs with subtitles", which is
the whole product. Drawn at 512 and LANCZOS-downsampled for crisp small sizes.

Run:  python3 make_icons.py
Emits: icon-16.png ... icon-128.png next to this file.
"""
import math
import os

from PIL import Image, ImageDraw, ImageFilter

OUT_DIR = os.path.dirname(os.path.abspath(__file__))

# Brand colors (sampled from overlay.css)
BG_TOP = (118, 189, 255)   # lighter accent
BG_BOT = (42, 127, 214)    # deeper accent (matches #4a9dff family)
WHITE = (255, 255, 255)
SHADOW = (20, 60, 120, 90)  # subtle inner depth for the note head


def rounded_gradient(size, radius):
    """A vertical-gradient rounded square with the given corner radius."""
    base = Image.new("RGB", (size, size), BG_BOT)
    grad = Image.new("RGB", (size, size))
    # build gradient by pasting horizontal lines of interpolated color
    for y in range(size):
        t = y / max(size - 1, 1)
        r = int(BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t)
        g = int(BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t)
        b = int(BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t)
        for x in range(size):
            grad.putpixel((x, y), (r, g, b))
    # cheaper: use a small gradient and resize up for speed
    return _mask_round(grad, radius)


def _mask_round(img, radius):
    mask = Image.new("L", img.size, 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, img.size[0] - 1, img.size[1] - 1],
                         radius=radius, fill=255)
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def gradient_fast(size, radius):
    """Faster gradient via a tiny strip resized up."""
    tiny = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(size - 1, 1)
        r = int(BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t)
        g = int(BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t)
        b = int(BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t)
        tiny.putpixel((0, y), (r, g, b))
    strip = tiny.resize((size, size))
    return _mask_round(strip, radius)


def draw_icon(size):
    s = 512  # working resolution
    radius = int(s * 0.22)  # macOS/Firefox-style squircle-ish corners
    img = gradient_fast(s, radius).convert("RGBA")
    d = ImageDraw.Draw(img)

    # Layout (fractions of s). Keep generous padding so the mark reads at 16px.
    pad = 0.16

    # --- Music note (eighth note) on the LEFT half ---
    # Note head: tilted filled ellipse, lower-left area.
    head_cx, head_cy = 0.30 * s, 0.66 * s
    head_rx, head_ry = 0.085 * s, 0.062 * s
    head_bbox = [head_cx - head_rx, head_cy - head_ry,
                 head_cx + head_rx, head_cy + head_ry]
    # soft shadow under head for a touch of depth (skip at tiny sizes)
    d.ellipse([head_bbox[0] + 0.004 * s, head_bbox[1] + 0.006 * s,
               head_bbox[2] + 0.004 * s, head_bbox[3] + 0.006 * s],
              fill=(10, 40, 90, 120))
    d.ellipse(head_bbox, fill=WHITE)

    # Stem: thin rounded rect going up from the right side of the head.
    stem_w = 0.028 * s
    stem_x0 = head_cx + head_rx - stem_w * 0.5
    stem_y0 = head_cy - head_ry  # top of head
    stem_y1 = 0.30 * s           # well above center
    d.rounded_rectangle([stem_x0, stem_y1, stem_x0 + stem_w, stem_y0],
                        radius=stem_w * 0.5, fill=WHITE)

    # Flag: a curved-ish triangle off the top of the stem (eighth-note flag).
    flag_top = stem_y1
    flag_anchor_x = stem_x0 + stem_w
    flag_pts = [
        (flag_anchor_x, flag_top),
        (flag_anchor_x + 0.085 * s, flag_top + 0.045 * s),
        (flag_anchor_x + 0.060 * s, flag_top + 0.115 * s),
        (flag_anchor_x, flag_top + 0.075 * s),
    ]
    d.polygon(flag_pts, fill=WHITE)

    # --- Subtitle lines on the RIGHT half (the "CC"/subtitle glyph) ---
    # Three rounded bars of differing widths, stacked, reading as text lines.
    line_x0 = 0.50 * s
    line_x_max = (1 - pad) * s
    line_h = 0.045 * s
    gap = 0.035 * s
    widths = [0.86, 0.62, 0.74]  # relative widths of the three lines
    # vertically center the 3-line block
    block_h = 3 * line_h + 2 * gap
    y = (s - block_h) / 2 + 0.02 * s  # nudge down to balance the note head
    for w_frac in widths:
        x1 = line_x0 + w_frac * (line_x_max - line_x0)
        d.rounded_rectangle([line_x0, y, x1, y + line_h],
                            radius=line_h * 0.5, fill=WHITE)
        y += line_h + gap

    # Downsample to target size with high quality.
    return img.resize((size, size), Image.LANCZOS)


def main():
    sizes = [16, 32, 48, 64, 96, 128]
    for sz in sizes:
        out = draw_icon(sz)
        path = os.path.join(OUT_DIR, f"icon-{sz}.png")
        out.save(path, "PNG")
        print("wrote", path)


if __name__ == "__main__":
    main()
