#!/usr/bin/env python3
"""
Redact sensitive text from a Bellhop screenshot by replacing it in place, at
native pixel fidelity, with a font-matched replacement - not a black bar.
See SKILL.md for the full procedure; this module is the three steps that
actually worked, in order:

    ink_bbox(img, region)                                  -> tight box around the real text
    best_fit(img, region, original_text, candidates, sizes) -> (font_path, size, origin, iou)
    redact(img, erase_box, font, origin, replacement_text, text_color, bg_color)

Why pixel redaction at all: the confirmation dialog lives inside a doubly
cross-origin iframe (<t>.cyberark.cloud -> managespace -> marketplace, see
CLAUDE.md "Tenant URL structure"), and javascript_tool only reaches the top
frame - there is no way to edit the dialog's DOM text before the screenshot
is taken. The text has to be covered after capture.

Fonts: a capture taken from a WSL2 host renders in Chrome's WINDOWS fonts
(/mnt/c/Windows/Fonts/) even though the automation agent itself runs on
Linux. `fc-list` / DejaVu is the wrong candidate set there - it was tried
and scored badly. The Bellhop dialog matched Segoe UI Bold (destination
tenant line) and Consolas (the pcloud host line, monospace). A capture from
Linux-native Chrome needs its own candidate list (`fc-list`) and its own
calibration run - don't reuse these answers on a different platform.

Colour: read the dialog's actual colour off extension/content.js's CSS,
don't sample it from pixels - antialiased edge pixels sample washed-out
towards grey and bias the match.
"""
import numpy as np
from PIL import Image, ImageDraw, ImageFont


def ink_bbox(img, region, threshold=700, ignore_border=0):
    """region=(x0,y0,x1,y1) in the image's own pixel space - use a native
    1:1 capture (zoom, not a downscaled full-page screenshot; see SKILL.md
    "Capture mechanics"). Returns a tight (x0,y0,x1,y1) around pixels whose
    RGB channel sum is below `threshold` (i.e. dark/ink pixels).

    Keep `region` restricted to the dialog's interior. The modal's own edge
    shadow/overlay reads as a constant ~16 dark px per row near the dialog
    boundary and will inflate every measurement if the region includes it;
    `ignore_border` trims a fixed margin before thresholding as a second
    safeguard."""
    x0, y0, x1, y1 = region
    arr = np.asarray(img.convert("RGB"), dtype=int)
    crop = arr[y0:y1, x0:x1]
    ox, oy = x0, y0
    if ignore_border:
        crop = crop[ignore_border:-ignore_border, ignore_border:-ignore_border]
        ox, oy = x0 + ignore_border, y0 + ignore_border
    dark = crop.sum(axis=2) < threshold
    ys, xs = np.nonzero(dark)
    if len(xs) == 0:
        raise ValueError(f"no ink found in region={region} at threshold={threshold}")
    return (ox + int(xs.min()), oy + int(ys.min()), ox + int(xs.max()) + 1, oy + int(ys.max()) + 1)


def origin_for(font, original_text, ink_topleft):
    """Recover the draw-origin point (PIL's default 'la' = left-ascender
    anchor) that produced ink starting at ink_topleft. font.getbbox(text)
    gives ink offset relative to the draw point, so subtracting it back out
    gives the point to pass to draw.text().

    This origin is a font-metric anchor, not a glyph-ink position - drawing
    a *different* string at the same origin, in the same font/size, lands
    it on the correct baseline automatically. That's why redact() reuses
    this origin for the replacement text rather than re-aligning ink boxes:
    two different strings have different ascenders/descenders, so aligning
    ink boxes directly shifts the visible baseline."""
    bx0, by0, _, _ = font.getbbox(original_text)
    ix, iy = ink_topleft
    return (ix - bx0, iy - by0)


def _mask(arr_or_img, threshold=700):
    arr = np.asarray(arr_or_img.convert("RGB"), dtype=int) if hasattr(arr_or_img, "convert") else arr_or_img
    return arr.sum(axis=2) < threshold


def _iou(a, b):
    ah, aw = a.shape
    bh, bw = b.shape
    uh, uw = max(ah, bh), max(aw, bw)
    A = np.zeros((uh, uw), dtype=bool)
    A[:ah, :aw] = a
    B = np.zeros((uh, uw), dtype=bool)
    B[:bh, :bw] = b
    inter = np.logical_and(A, B).sum()
    union = np.logical_or(A, B).sum()
    return inter / union if union else 0.0


def _render_mask(font, text, origin, canvas_box, threshold):
    """Render text at `origin` (image coords, may be fractional) into a
    canvas covering canvas_box=(x0,y0,x1,y1). Pillow's FreeType backend
    rasterizes fractional draw coordinates directly (confirmed: a 0.5px
    shift measurably changes the output), so 0.5px origin sweeps in
    best_fit() render natively here - no supersample-then-downscale trick,
    which was tried first and rejected: downscaling with LANCZOS softens
    edges enough to push real ink pixels above the dark-pixel threshold,
    understating the true ink count by ~3x even for an exact font/size/
    position match."""
    x0, y0, x1, y1 = canvas_box
    w, h = x1 - x0, y1 - y0
    canvas = Image.new("RGB", (w, h), (255, 255, 255))
    ImageDraw.Draw(canvas).text((origin[0] - x0, origin[1] - y0),
                                 text, font=font, fill=(0, 0, 0))
    return _mask(np.asarray(canvas), threshold)


def best_fit(img, region, original_text, candidates, sizes, threshold=700, ignore_border=0):
    """Sweep (font, size), then refine the origin by +/-2px in 0.5px steps,
    scoring each attempt by IoU against the real ink - and always rendering
    the ORIGINAL sensitive text (the string you can still read in the raw
    screenshot), never the replacement, since the goal is to find what the
    browser actually used to draw the real string.

    Confirms candidates cheaply on ink WIDTH first (font.getbbox width vs
    measured ink width, allow a few px) before the expensive per-candidate
    render+IoU pass - most candidates fail this instantly.

    Returns (font_path, size, origin, iou). Treat iou < 0.6 as "wrong font
    or size, don't ship it" - widen the candidate list or size range and
    retry. 0.75-0.9 is the realistic ceiling for a correct match: Chrome's
    antialiasing is heavier than Pillow's rasterizer, so a perfect match
    never reads 1.0."""
    bbox = ink_bbox(img, region, threshold, ignore_border)
    x0, y0, x1, y1 = bbox
    pad = 20
    # Clamp to the caller's region, not just the ink box +/- pad: padding
    # blindly can bleed into a neighbouring text line (e.g. two dialog
    # lines ~30px apart) and silently inflate the "actual" pixel count.
    rx0, ry0, rx1, ry1 = region
    canvas_box = (max(x0 - pad, rx0), max(y0 - pad, ry0),
                  min(x1 + pad, rx1), min(y1 + pad, ry1))
    actual = _mask(img.crop(canvas_box), threshold)
    ink_w = x1 - x0

    best = (None, None, None, -1.0)
    for font_path in candidates:
        for size in sizes:
            try:
                font = ImageFont.truetype(font_path, size)
            except OSError:
                continue
            bx0, by0, bx1, by1 = font.getbbox(original_text)
            if abs((bx1 - bx0) - ink_w) > max(4, ink_w * 0.04):
                continue
            base_origin = origin_for(font, original_text, (x0, y0))
            for dxi in range(-4, 5):       # -2.0 .. +2.0 px in 0.5 steps
                for dyi in range(-4, 5):
                    dx, dy = dxi * 0.5, dyi * 0.5
                    origin = (base_origin[0] + dx, base_origin[1] + dy)
                    rendered = _render_mask(font, original_text, origin, canvas_box, threshold)
                    score = _iou(actual, rendered)
                    if score > best[3]:
                        best = (font_path, size, origin, score)
    return best


def inspect_3x(img, region, out_path):
    """Save a 3x NEAREST-upscaled crop of region for visual inspection.
    Required both before erasing (to see the true ink extent, including
    ascenders/descenders that a naive line-height box would clip) and after
    drawing (to catch a misaligned baseline or wrong font weight that OCR
    alone would miss)."""
    x0, y0, x1, y1 = region
    crop = img.crop((x0, y0, x1, y1))
    crop.resize((crop.width * 3, crop.height * 3), Image.NEAREST).save(out_path)


def redact(img, erase_box, font, origin, replacement_text, text_color, bg_color):
    """erase_box=(x0,y0,x1,y1) - pad generously above/below the measured ink
    to clear ascenders and descenders in full, but check with inspect_3x()
    that it doesn't bleed into a neighbouring line first. `origin` is the
    anchor point from origin_for() / best_fit() - NOT the ink top-left;
    drawing the replacement there is what keeps it on the real baseline
    regardless of how its own ascenders/descenders differ from the original
    string. Mutates and returns img."""
    draw = ImageDraw.Draw(img)
    draw.rectangle(erase_box, fill=bg_color)
    draw.text(origin, replacement_text, font=font, fill=text_color)
    return img
