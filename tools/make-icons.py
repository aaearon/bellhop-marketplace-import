# Run: python3 tools/make-icons.py
"""Generate the Bellhop Chrome extension icon set.

Draws a hotel reception desk bell (half-dome body on a flat base bar,
with a small press-button on top) at 8x supersample resolution using
Pillow ImageDraw, then downsamples with LANCZOS to each target size.
Also renders a review sheet (preview.png) showing all sizes together,
including 4x-magnified 16px/32px crops so smallness can be judged.
"""

from __future__ import annotations

import os

from PIL import Image, ImageDraw, ImageFont

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICONS_DIR = os.path.join(REPO_ROOT, "extension", "icons")

NAVY = (15, 23, 42, 255)  # #0F172A
AMBER = (251, 191, 36, 255)  # #FBBF24
SUPERSAMPLE = 8

TARGET_SIZES = [16, 32, 48, 128]

# Bell proportions, all expressed relative to the dome width W so the
# silhouette reads as a hotel desk bell (tall near-hemisphere dome on a
# thin plate) rather than a food cloche. Applied identically at every
# target size -- only the press-button/stem are dropped at 16px, where
# they'd be illegible; the dome/base ratios stay the same.
DOME_HEIGHT_RATIO = 0.60  # visible dome half-height / W
BASE_HEIGHT_RATIO = 0.10  # base plate height / W
BASE_WIDTH_RATIO = 1.10  # base plate width / W
BUTTON_DIAMETER_RATIO = 0.16  # press-button diameter / W
STEM_HEIGHT_RATIO = 0.06  # stem height (gap between dome apex and button) / W
STEM_WIDTH_RATIO = 0.05  # stem width / W (thin neck, keeps button separate)


def draw_bell(draw: ImageDraw.ImageDraw, size: int, simplified: bool) -> None:
    """Draw the bell artwork (base plate + dome + button-on-stem) centered
    in a canvas of the given size (in supersampled pixels).

    `simplified` drops the press-button/stem for legibility at very small
    target sizes (used for the 16px icon); dome/base proportions are the
    same as the full artwork.
    """
    cx = size / 2.0
    # Bell reads bottom-heavy, so nudge the optical center up a touch.
    cy = size / 2.0 - size * 0.03

    dome_w = size * 0.70  # ~15% padding each side; W in the ratio constants

    # Flat seam between dome and base plate sits just below the vertical center.
    seam_y = cy + size * 0.06

    dome_half_h = dome_w * DOME_HEIGHT_RATIO  # visible (top-half) height

    dome_left = cx - dome_w / 2.0
    dome_right = cx + dome_w / 2.0
    dome_top = seam_y - dome_half_h
    dome_bottom = seam_y + dome_half_h

    # Half-dome: top half of a full ellipse (flat edge = diameter, at the
    # seam; curved edge = the dome crown). start/end at 180/360 keeps the
    # flat edge perfectly horizontal with no stray radius lines.
    draw.pieslice(
        [dome_left, dome_top, dome_right, dome_bottom],
        start=180,
        end=360,
        fill=AMBER,
    )

    # Thin base plate (the counter surface the bell sits on) -- only
    # slightly wider than the dome, and much shorter than it is wide.
    base_w = dome_w * BASE_WIDTH_RATIO
    base_h = dome_w * BASE_HEIGHT_RATIO
    base_left = cx - base_w / 2.0
    base_right = cx + base_w / 2.0
    base_top = seam_y - size * 0.01
    base_bottom = base_top + base_h
    base_radius = base_h * 0.35
    draw.rounded_rectangle(
        [base_left, base_top, base_right, base_bottom],
        radius=base_radius,
        fill=AMBER,
    )

    if not simplified:
        # Small round press-button, lifted clear of the dome crown on a
        # thin stem so it reads as a distinct part, not a fused handle.
        button_r = dome_w * BUTTON_DIAMETER_RATIO / 2.0
        stem_w = dome_w * STEM_WIDTH_RATIO
        stem_h = dome_w * STEM_HEIGHT_RATIO

        stem_top_y = dome_top - stem_h
        button_cx = cx
        button_cy = stem_top_y - button_r

        draw.rectangle(
            [cx - stem_w / 2.0, stem_top_y, cx + stem_w / 2.0, dome_top],
            fill=AMBER,
        )
        draw.ellipse(
            [
                button_cx - button_r,
                button_cy - button_r,
                button_cx + button_r,
                button_cy + button_r,
            ],
            fill=AMBER,
        )


def render_icon(target_size: int) -> Image.Image:
    """Render one icon at `target_size`, via supersampled draw + downsample."""
    ss_size = target_size * SUPERSAMPLE
    img = Image.new("RGBA", (ss_size, ss_size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    corner_radius = ss_size * 0.18
    draw.rounded_rectangle(
        [0, 0, ss_size - 1, ss_size - 1],
        radius=corner_radius,
        fill=NAVY,
    )

    # 16px toolbar icons get chunkier, button-free artwork for legibility.
    simplified = target_size <= 16
    draw_bell(draw, ss_size, simplified=simplified)

    return img.resize((target_size, target_size), Image.LANCZOS)


def build_preview(icons: dict[int, Image.Image]) -> Image.Image:
    """Build a labelled review sheet: all sizes side by side, plus 4x
    nearest-neighbour magnified crops of the 16px and 32px icons."""
    try:
        font = ImageFont.load_default(size=18)
    except TypeError:
        font = ImageFont.load_default()

    pad = 24
    label_h = 28
    row_h = 128 + label_h + pad

    magnified = {s: icons[s].resize((icons[s].width * 4, icons[s].height * 4), Image.NEAREST) for s in (16, 32)}

    col_widths = [max(icons[s].width, 128) for s in TARGET_SIZES]
    col_widths += [magnified[16].width, magnified[32].width]
    sheet_w = pad + sum(w + pad for w in col_widths)
    sheet_h = row_h + pad

    sheet = Image.new("RGBA", (sheet_w, sheet_h), (128, 128, 128, 255))
    draw = ImageDraw.Draw(sheet)

    x = pad
    for s in TARGET_SIZES:
        icon = icons[s]
        col_w = max(icon.width, 128)
        icon_x = x + (col_w - icon.width) // 2
        icon_y = pad
        sheet.alpha_composite(icon, (icon_x, icon_y))
        label = f"{s}x{s}"
        tw = draw.textlength(label, font=font)
        draw.text((x + (col_w - tw) / 2, icon_y + 128 + 6), label, fill=(20, 20, 20, 255), font=font)
        x += col_w + pad

    for s in (16, 32):
        icon = magnified[s]
        col_w = icon.width
        icon_y = pad
        sheet.alpha_composite(icon, (x, icon_y))
        label = f"{s}x{s} @4x"
        tw = draw.textlength(label, font=font)
        draw.text((x + (col_w - tw) / 2, icon_y + icon.height + 6), label, fill=(20, 20, 20, 255), font=font)
        x += col_w + pad

    return sheet


def main() -> None:
    os.makedirs(ICONS_DIR, exist_ok=True)

    icons: dict[int, Image.Image] = {}
    for size in TARGET_SIZES:
        icon = render_icon(size)
        icons[size] = icon
        out_path = os.path.join(ICONS_DIR, f"icon{size}.png")
        icon.save(out_path)
        print(f"wrote {out_path} ({icon.size[0]}x{icon.size[1]})")

    preview = build_preview(icons)
    preview_path = os.path.join(ICONS_DIR, "preview.png")
    preview.save(preview_path)
    print(f"wrote {preview_path} ({preview.size[0]}x{preview.size[1]})")


if __name__ == "__main__":
    main()
