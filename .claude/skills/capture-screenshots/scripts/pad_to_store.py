#!/usr/bin/env python3
"""
Pad an image onto a fixed-size canvas (default 1280x800, Chrome Web Store /
Edge Add-ons also accept 640x400) without distorting it. Scales down only if
the source exceeds the target box (never scales up), centres it, and fills
the margin with a neutral colour - by default sampled from the source
image's own top-left corner pixel, so the padding matches the screenshot's
own chrome rather than introducing a jarring new background.

Run this ONLY on an already-redacted image. Never redact the store variant
separately from the full-size original - scaling reuses the same redacted
pixels, so the two images cannot drift out of sync with each other. If you
redact each size independently you can end up with a full-size image that's
clean and a store image that isn't (or a font-match that differs between the
two), and nothing will warn you.

Usage:
    python3 pad_to_store.py IMAGE.png --out OUT.png
    python3 pad_to_store.py IMAGE.png --out OUT.png --size 640x400 --bg 245,245,245
"""
import argparse

from PIL import Image


def pad_to_store(img, size=(1280, 800), bg=None):
    tw, th = size
    img = img.convert("RGB")
    w, h = img.size
    scale = min(tw / w, th / h, 1.0)  # never upscale
    if scale < 1.0:
        img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
        w, h = img.size
    if bg is None:
        bg = img.getpixel((0, 0))
    canvas = Image.new("RGB", size, bg)
    canvas.paste(img, ((tw - w) // 2, (th - h) // 2))
    return canvas


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("image")
    p.add_argument("--out", required=True)
    p.add_argument("--size", default="1280x800")
    p.add_argument("--bg", help="r,g,b; default samples the image's own top-left pixel")
    args = p.parse_args()
    tw, th = (int(v) for v in args.size.split("x"))
    bg = tuple(int(v) for v in args.bg.split(",")) if args.bg else None
    img = Image.open(args.image)
    pad_to_store(img, (tw, th), bg).save(args.out)
    print(f"padded to {tw}x{th} -> {args.out}")
