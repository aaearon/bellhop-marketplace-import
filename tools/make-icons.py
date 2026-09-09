#!/usr/bin/env python3
# Run: python3 tools/make-icons.py   (from the repo root; paths are repo-root-relative)
"""Generate the Bellhop Chrome extension icon set, standalone and deterministic.

Writes extension/icons/icon{16,32,48,128}.png, extension/icons/preview.png,
and docs/images/promo-tile-440x280.png (the Chrome Web Store "small promo
tile"; Edge accepts the same dimensions, optionally). No dependency on
anything outside this repo -- the SVG artwork, the rasteriser invocation, and
the downsample/mask pipeline are all inline below.

Deliberate size split (do not simplify to one artwork for all sizes):
  - 128px and 48px  -> the full Bellhop CHARACTER (bellhop cap, torso, arms,
    parcel-in-hand). Below 48px this silhouette collapses into noise -- the
    character does not survive at 32/16px.
  - 32px and 16px   -> the PARCEL mark alone (the box the character is
    holding, reduced to a plain blue box with a white lid -- no ribbon; at
    this size a ribbon crossing the box reads as a split, not a decoration,
    so it's dropped and the lid/face colour boundary alone carries the seam).
    At toolbar sizes it stays an unambiguous package; the cap/character
    instead reduces to a cap-shaped blob that reads as a pastry, not headwear.
This mapping is fixed in TARGET_SIZES / ARTWORK_FOR_SIZE below -- it is not
something later edits should collapse to "one image, four sizes".

Pipeline (character and mark are both authored the same way):
  1. Hand-written SVG path data on a 1024x1024 canvas (Bezier-based paths,
     built with small geometry helpers below -- taper() for limbs,
     bowed_quad() for the parcel/ribbon panels).
  2. Rasterised via ImageMagick's `convert` CLI (its built-in MSVG renderer).
     This is a deliberate choice -- there is no rsvg-convert on this box, so
     the pipeline must not depend on it.
  3. Downsampled from 1024 to the target icon size with Pillow LANCZOS.
  4. Given Chrome's rounded-square treatment: an 18%-radius rounded-rect
     alpha mask, itself drawn at 2x the target size and LANCZOS-downsampled
     back down so the corner curve stays smooth instead of jagged.
"""

from __future__ import annotations

import math
import os
import subprocess
import tempfile

from PIL import Image, ImageDraw, ImageFont

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICONS_DIR = os.path.join(REPO_ROOT, "extension", "icons")
PROMO_TILE_PATH = os.path.join(REPO_ROOT, "docs", "images", "promo-tile-440x280.png")
PROMO_TILE_SIZE = (440, 280)  # Chrome Web Store "small promo tile"; Edge accepts the same size

# Bold sans TrueType fonts to try for the promo tile's "Bellhop" wordmark, in
# preference order. Both are commonly-packaged Linux distro fonts (Liberation
# Sans is metric-compatible with Helvetica/Arial); if neither is installed,
# find_font() raises rather than silently falling back to Pillow's default
# bitmap font, which is illegible at the sizes this tile needs.
WORDMARK_FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]

S = 1024  # master SVG canvas (both character and mark render at this size)

# ---------------------------------------------------------------- brand palette
# Idira/CyberArk brand colours -- NOT Palo Alto Networks orange. Idira is PAN's
# rebrand of CyberArk, but it carries CyberArk's own blue-anchored identity,
# not PAN's corporate orange (an earlier version of this file used PAN orange;
# that was wrong and was corrected 2026-09-09).
# Source-level values, superseding an earlier brandcolorcode.com-derived pass:
# sampled directly from https://marketplace.idira.pan.dev/brand/idira-marketplace.svg
# (fill attributes on the live brand SVG) and cross-checked against computed
# styles on the live marketplace page, 2026-09-09:
#   - #265BFF -- fill of the logo hexagon mark; cross-validated against the
#     primary search button, which computes to #2E6BFF (same family).
#   - #304FFE -- the dark stop of the hero gradient
#     (linear-gradient(#3D88FF 10%, #304FFE 100%)); an actual brand value, not
#     a value-scaled derivative.
#   - #141414 -- fill of the "IDIRA" wordmark in the same SVG; matches
#     IDIRA_CHARCOAL below exactly.
# There is no Palo Alto orange anywhere in the brand SVG or computed styles;
# the one amber note (#FFBB00) is a gold hero-text accent, not used here.
#
# Contrast against IDIRA_CHARCOAL (#141414), WCAG relative-luminance ratios:
#   - IDIRA_BLUE (#265BFF):       ~3.53:1 -- above the 3:1 WCAG minimum for
#     non-text/graphical objects; tighter than a lightened tint would give,
#     but the mark is a bold fill area, not fine detail, and the white lid
#     supplies the strongest separation in the small mark.
#   - IDIRA_BLUE_SHADE (#304FFE): ~3.22:1 -- used only for small shaded
#     surfaces on the 48/128 character (near arm, far torso, brim), where
#     size compensates for the tighter ratio.
IDIRA_BLUE = "#265BFF"  # Idira primary blue -- logo hexagon fill
IDIRA_BLUE_SHADE = "#304FFE"  # Idira brand value (hero-gradient dark stop), for shaded/far-side surfaces
IDIRA_CHARCOAL = "#141414"  # near-black background/ribbon/badge/eyes/mouth
IDIRA_WHITE = "#FFFFFF"  # white

TARGET_SIZES = [16, 32, 48, 128]
# size -> which artwork to use ("character" or "mark"); see split above.
ARTWORK_FOR_SIZE = {16: "mark", 32: "mark", 48: "character", 128: "character"}
CORNER_RADIUS_FRACTION = 0.18


# ============================================================ geometry helpers
def rot(pts, deg, cx, cy, tx, ty):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return [((x - cx) * c - (y - cy) * s + tx, (x - cx) * s + (y - cy) * c + ty) for x, y in pts]


def path(cmds, deg=0.0, cx=0.0, cy=0.0, tx=0.0, ty=0.0, sc=1.0):
    """Turn a list of (letter, [pts]) SVG path segments into a `d` string,
    applying a uniform scale then rotation-about-(cx,cy)-then-translate."""
    flat, idx = [], []
    for letter, pts in cmds:
        idx.append((letter, len(pts)))
        flat.extend([(x * sc, y * sc) for x, y in pts])
    flat = rot(flat, deg, cx, cy, tx, ty)
    out, i = [], 0
    for letter, n in idx:
        out.append(letter + " " + " ".join("%.2f,%.2f" % flat[i + k] for k in range(n)))
        i += n
    return " ".join(out) + " Z"


def poly(pts):
    return "M " + " L ".join("%.2f,%.2f" % p for p in pts) + " Z"


def _bez(p0, p1, p2, p3, t):
    u = 1 - t
    return (
        u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
        u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    )


def taper(chain, w0, w1, bulge=1.0, n=40):
    """Build a filled outline for a tapered limb along a chain of cubic
    Bezier control points (4 points per segment, sharing endpoints)."""
    segs = [(chain[i], chain[i + 1], chain[i + 2], chain[i + 3]) for i in range(0, len(chain) - 3, 3)]
    pts = []
    for si, seg in enumerate(segs):
        for k in range(n + (1 if si == len(segs) - 1 else 0)):
            pts.append(_bez(*seg, k / n))
    N = len(pts) - 1
    L, R = [], []
    for i, pt in enumerate(pts):
        u = i / N
        a = pts[min(i + 1, N)]
        b = pts[max(i - 1, 0)]
        dx, dy = a[0] - b[0], a[1] - b[1]
        m = math.hypot(dx, dy) or 1.0
        nx, ny = -dy / m, dx / m
        w = w0 + (w1 - w0) * (u * u * (3 - 2 * u))
        w += bulge * 0.14 * w0 * math.sin(math.pi * min(1.0, u * 1.35))
        L.append((pt[0] + nx * w, pt[1] + ny * w))
        R.append((pt[0] - nx * w, pt[1] - ny * w))
    ex, ey = pts[N]
    px, py = pts[N - 1]
    dx, dy = ex - px, ey - py
    m = math.hypot(dx, dy) or 1.0
    dx, dy = dx / m, dy / m
    we = w1
    cap = [
        (ex + dx * we * math.sin(th) - dy * we * math.cos(th), ey + dy * we * math.sin(th) + dx * we * math.cos(th))
        for th in [k * math.pi / 8 for k in range(1, 8)]
    ]
    sx, sy = pts[0]
    qx, qy = pts[1]
    dx, dy = sx - qx, sy - qy
    m = math.hypot(dx, dy) or 1.0
    dx, dy = dx / m, dy / m
    scap = [
        (sx + dx * w0 * math.sin(th) + dy * w0 * math.cos(th), sy + dy * w0 * math.sin(th) - dx * w0 * math.cos(th))
        for th in [k * math.pi / 8 for k in range(1, 8)]
    ]
    return poly(L + cap + R[::-1] + scap)


def bowed_quad(q, bow=0.014, jitter=(1.0, -0.6, 0.35, -1.15)):
    """A four-sided panel (parcel face, lid, ribbon strip) with slightly
    bowed-outward edges instead of dead-straight ones, for a hand-drawn feel."""
    d = ""
    for i in range(4):
        a, b = q[i], q[(i + 1) % 4]
        mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
        dx, dy = b[0] - a[0], b[1] - a[1]
        k = bow * jitter[i]
        cx, cy = mx - dy * k, my + dx * k
        c1 = (a[0] + (cx - a[0]) * 1.34, a[1] + (cy - a[1]) * 1.34)
        c2 = (b[0] + (cx - b[0]) * 1.34, b[1] + (cy - b[1]) * 1.34)
        d += ("M %.2f,%.2f " % a) if i == 0 else ""
        d += "C %.2f,%.2f %.2f,%.2f %.2f,%.2f " % (c1[0], c1[1], c2[0], c2[1], b[0], b[1])
    return d + "Z"


def box_faces(cx, cy, w, h, lid, dx, tilt):
    """Front face + lid-top face of a gift-box parcel, as point quads."""
    fr = [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2 + 5, h / 2), (-w / 2 + 3, h / 2)]
    top = [fr[0], fr[1], (fr[1][0] + dx, fr[1][1] - lid), (fr[0][0] + dx, fr[0][1] - lid)]
    return rot(fr, tilt, 0, 0, cx, cy), rot(top, tilt, 0, 0, cx, cy)


def ribbon(q, t0=0.40, t1=0.60, over=0.05):
    """A diagonal ribbon strip crossing one quad panel `q`."""
    a, b, c, d = q
    L = lambda p, r, t: (p[0] + (r[0] - p[0]) * t, p[1] + (r[1] - p[1]) * t)
    p1, p2 = L(a, b, t0), L(a, b, t1)
    p3, p4 = L(d, c, t1 + 0.03), L(d, c, t0 + 0.03)
    ex1 = (p1[0] + (p1[0] - p4[0]) * over, p1[1] + (p1[1] - p4[1]) * over)
    ex2 = (p2[0] + (p2[0] - p3[0]) * over, p2[1] + (p2[1] - p3[1]) * over)
    ex3 = (p3[0] + (p3[0] - p2[0]) * over * 0.8, p3[1] + (p3[1] - p2[1]) * over * 0.8)
    ex4 = (p4[0] + (p4[0] - p1[0]) * over * 0.8, p4[1] + (p4[1] - p1[1]) * over * 0.8)
    return bowed_quad([ex1, ex2, ex3, ex4], bow=0.008, jitter=(0.5, -0.9, 0.4, -0.6))


def glove(cx, cy, w, h, tilt, flip=1):
    """A chunky mitten hand: flat fingertips, a real thumb off one side,
    wrist narrower than the palm. Fingers point -y before `tilt` is applied."""
    pts = [
        ("M", [(0.30 * w, 0.46 * h)]),
        ("C", [(0.40 * w, 0.30 * h), (0.43 * w, 0.06 * h), (0.42 * w, -0.16 * h)]),
        ("C", [(0.41 * w, -0.38 * h), (0.26 * w, -0.51 * h), (0.04 * w, -0.51 * h)]),
        ("C", [(-0.16 * w, -0.51 * h), (-0.30 * w, -0.41 * h), (-0.32 * w, -0.25 * h)]),
        ("C", [(-0.34 * w, -0.19 * h), (-0.44 * w, -0.32 * h), (-0.56 * w, -0.29 * h)]),
        ("C", [(-0.68 * w, -0.26 * h), (-0.70 * w, -0.06 * h), (-0.58 * w, 0.03 * h)]),
        ("C", [(-0.48 * w, 0.10 * h), (-0.38 * w, 0.08 * h), (-0.33 * w, 0.14 * h)]),
        ("C", [(-0.29 * w, 0.21 * h), (-0.28 * w, 0.34 * h), (-0.26 * w, 0.46 * h)]),
        ("C", [(-0.14 * w, 0.53 * h), (0.18 * w, 0.53 * h), (0.30 * w, 0.46 * h)]),
    ]
    if flip < 0:
        pts = [(l, [(-x, y) for x, y in ps]) for l, ps in pts]
    return path(pts, tilt, 0, 0, cx, cy)


# ============================================================ character artwork
HTILT, HX, HY, HS = -5.5, 466.0, 398.0, 0.97


def H(c):
    return path(c, HTILT, 0, 0, HX, HY, HS)


HEAD = [
    ("M", [(-10, -166)]),
    ("C", [(66, -170), (122, -124), (136, -52)]),
    ("C", [(143, -12), (145, 20), (145, 52)]),
    ("C", [(145, 82), (134, 110), (106, 134)]),
    ("C", [(78, 158), (30, 176), (-24, 174)]),
    ("C", [(-72, 172), (-116, 146), (-136, 106)]),
    ("C", [(-147, 82), (-151, 44), (-150, 6)]),
    ("C", [(-147, -64), (-134, -116), (-106, -142)]),
    ("C", [(-78, -166), (-46, -164), (-10, -166)]),
]

CROWN = [
    ("M", [(-152, -58)]),
    ("C", [(-159, -142), (-86, -198), (22, -196)]),
    ("C", [(124, -194), (163, -138), (156, -66)]),
    ("C", [(104, -44), (-6, -34), (-92, -44)]),
    ("C", [(-120, -48), (-143, -51), (-152, -58)]),
]

BRIM = [
    ("M", [(-172, -34)]),
    ("C", [(-110, -6), (70, 6), (186, -22)]),
    ("C", [(238, -34), (274, -54), (292, -70)]),
    ("C", [(306, -88), (280, -114), (248, -102)]),
    ("C", [(190, -80), (100, -62), (10, -60)]),
    ("C", [(-72, -58), (-138, -70), (-172, -86)]),
    ("C", [(-196, -76), (-192, -46), (-172, -34)]),
]

BADGE = [
    ("M", [(-30, -126)]),
    ("C", [(4, -144), (40, -160), (62, -166)]),
    ("C", [(82, -171), (96, -156), (90, -140)]),
    ("C", [(84, -126), (42, -110), (4, -96)]),
    ("C", [(-18, -88), (-36, -96), (-38, -110)]),
    ("C", [(-39, -119), (-35, -123), (-30, -126)]),
]

EYE_NEAR = [
    ("M", [(-96, 8)]),
    ("C", [(-74, 0), (-54, 19), (-54, 44)]),
    ("C", [(-54, 66), (-70, 80), (-88, 74)]),
    ("C", [(-103, 68), (-111, 52), (-112, 36)]),
    ("C", [(-113, 22), (-105, 12), (-96, 8)]),
]
EYE_FAR = [
    ("M", [(6, 12)]),
    ("C", [(18, 7), (28, 19), (28, 35)]),
    ("C", [(28, 50), (20, 60), (8, 56)]),
    ("C", [(-4, 52), (-8, 38), (-6, 25)]),
    ("C", [(-4, 17), (1, 14), (6, 12)]),
]
GLINT = [
    ("M", [(-97, 23)]),
    ("C", [(-90, 17), (-79, 23), (-80, 34)]),
    ("C", [(-81, 44), (-91, 46), (-96, 40)]),
    ("C", [(-101, 35), (-101, 27), (-97, 23)]),
]

MOUTH = [
    ("M", [(-80, 106)]),
    ("C", [(-56, 96), (-16, 94), (4, 100)]),
    ("C", [(2, 121), (-20, 140), (-46, 137)]),
    ("C", [(-66, 134), (-80, 120), (-80, 106)]),
]

BTILT, BX, BY = -6.0, 516.0, 800.0


def BODY(cmds):
    return path(cmds, BTILT, 0, 0, BX, BY)


TORSO = [
    ("M", [(-150, 262)]),
    ("C", [(-134, 150), (-120, 40), (-134, -60)]),
    ("C", [(-146, -134), (-84, -206), (10, -212)]),
    ("C", [(108, -218), (176, -160), (196, -88)]),
    ("C", [(218, -14), (200, 142), (192, 262)]),
]
TORSO_FAR = [
    ("M", [(192, 262)]),
    ("C", [(200, 142), (218, -14), (196, -88)]),
    ("C", [(187, -114), (176, -138), (162, -156)]),
    ("C", [(170, -80), (156, 142), (148, 262)]),
]

ARM_FAR_D = taper(
    [(694, 752), (812, 744), (886, 650), (884, 470), (880, 424), (800, 348), (706, 328)], 46, 28, bulge=0.6
)
ARM_NEAR_D = taper(
    [(474, 700), (398, 716), (330, 748), (296, 792), (288, 810), (288, 830), (298, 848)], 40, 31, bulge=0.5
)

HAND_FAR_D = glove(632, 302, 146, 116, -95, flip=-1)
HAND_NEAR_D = glove(262, 822, 138, 112, -78, flip=-1)

# the parcel the character is holding (character-scale, positioned in canvas coords)
_PCX, _PCY = 188, 786
_FR, _TOP = box_faces(_PCX, _PCY, 170, 146, 56, 58, -8.0)
PARCEL_D = bowed_quad(_FR, bow=0.007, jitter=(1.0, -0.5, 0.4, -0.9))
LID_D = bowed_quad(_TOP, bow=0.005, jitter=(0.6, -0.4, 0.5, -0.7))
RIBBON_D = ribbon(_FR, t0=0.42, t1=0.575)
LIDBAND_D = ribbon(_TOP, t0=0.42, t1=0.575, over=0.0)


def svg_character(glint=True):
    g = f'<path d="{H(GLINT)}" fill="{IDIRA_WHITE}"/>' if glint else ""
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}" viewBox="0 0 1024 1024">
<rect width="1024" height="1024" fill="{IDIRA_CHARCOAL}"/>
<path d="{ARM_NEAR_D}" fill="{IDIRA_BLUE_SHADE}"/>
<path d="{BODY(TORSO)}" fill="{IDIRA_BLUE}"/>
<path d="{BODY(TORSO_FAR)}" fill="{IDIRA_BLUE_SHADE}"/>
<path d="{ARM_FAR_D}" fill="{IDIRA_BLUE}"/>
<path d="{H(HEAD)}" fill="{IDIRA_WHITE}"/>
<path d="{H(EYE_NEAR)}" fill="{IDIRA_CHARCOAL}"/>
<path d="{H(EYE_FAR)}" fill="{IDIRA_CHARCOAL}"/>
<path d="{H(MOUTH)}" fill="{IDIRA_CHARCOAL}"/>
{g}
<path d="{H(BRIM)}" fill="{IDIRA_BLUE_SHADE}"/>
<path d="{H(CROWN)}" fill="{IDIRA_BLUE}"/>
<path d="{H(BADGE)}" fill="{IDIRA_CHARCOAL}"/>
<path d="{HAND_FAR_D}" fill="{IDIRA_WHITE}"/>
<path d="{LID_D}" fill="{IDIRA_WHITE}"/>
<path d="{PARCEL_D}" fill="{IDIRA_BLUE}"/>
<path d="{LIDBAND_D}" fill="{IDIRA_CHARCOAL}"/>
<path d="{RIBBON_D}" fill="{IDIRA_CHARCOAL}"/>
<path d="{HAND_NEAR_D}" fill="{IDIRA_WHITE}"/>
</svg>"""


# =============================================================== parcel mark
# The reduced mark used at 32/16px: just the box the character is holding,
# recentred and scaled to fill the canvas on its own.
_MARK_TILT = -6.0


def _fit(quads, margin=0.13):
    pts = []
    for q in quads:
        pts += q
    pts = rot(pts, _MARK_TILT, 0, 0, 0, 0)
    x0, x1 = min(p[0] for p in pts), max(p[0] for p in pts)
    y0, y1 = min(p[1] for p in pts), max(p[1] for p in pts)
    sc = (1024 * (1 - 2 * margin)) / max(x1 - x0, y1 - y0)
    return sc, 512 - (x0 + x1) / 2 * sc, 512 - (y0 + y1) / 2 * sc


def svg_mark():
    fr, top = box_faces(0, 0, 300, 268, 72, 66, 0.0)
    sc, tx, ty = _fit([fr, top])
    F = [(x * sc + tx, y * sc + ty) for x, y in rot(fr, _MARK_TILT, 0, 0, 0, 0)]
    T = [(x * sc + tx, y * sc + ty) for x, y in rot(top, _MARK_TILT, 0, 0, 0, 0)]
    # No ribbon here, deliberately: at 16/32px the box outline IS the mark, and
    # a vertical ribbon crossing it -- at any contrast high enough to read as
    # a ribbon -- reads instead as a gap that splits the box into two slabs
    # (observed: charcoal ribbon on the orange front looked like a quotation
    # mark, not a parcel). The lid/face colour split alone (white top, orange
    # front) is the seam and is sufficient to read as a box at this size. The
    # character artwork at 48/128px keeps its full ribbon detail -- see
    # svg_character -- since the silhouette is large enough there to carry it.
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}" viewBox="0 0 1024 1024">
<rect width="1024" height="1024" fill="{IDIRA_CHARCOAL}"/>
<path d="{bowed_quad(T, bow=0.004)}" fill="{IDIRA_WHITE}"/>
<path d="{bowed_quad(F, bow=0.005)}" fill="{IDIRA_BLUE}"/>
</svg>"""


# =============================================================== render pipeline
def render_svg(svg_text: str) -> Image.Image:
    """Rasterise `svg_text` (a full 1024x1024 <svg> document) via ImageMagick's
    `convert` -- its built-in MSVG renderer, not rsvg-convert (not installed)."""
    with tempfile.TemporaryDirectory() as tmp:
        svg_path = os.path.join(tmp, "master.svg")
        png_path = os.path.join(tmp, "master.png")
        with open(svg_path, "w") as f:
            f.write(svg_text)
        subprocess.run(["convert", svg_path, png_path], check=True)
        return Image.open(png_path).convert("RGBA")


def rounded_mask(img: Image.Image, rf: float = CORNER_RADIUS_FRACTION) -> Image.Image:
    """Apply an rf-radius rounded-rect alpha mask to `img`, antialiasing the
    corner by drawing the mask at 2x size and LANCZOS-downsampling it."""
    n = img.size[0]
    m = Image.new("L", (n * 2, n * 2), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, n * 2 - 1, n * 2 - 1], radius=int(n * 2 * rf), fill=255)
    m = m.resize((n, n), Image.LANCZOS)
    out = img.convert("RGBA")
    out.putalpha(m)
    return out


def make_icon(master: Image.Image, size: int) -> Image.Image:
    """Downsample the 1024px master render to `size` with LANCZOS, then apply
    the rounded-corner mask."""
    return rounded_mask(master.resize((size, size), Image.LANCZOS))


# =============================================================== preview sheet
def build_preview(icons: dict[int, Image.Image]) -> Image.Image:
    """A labelled review sheet: all four sizes at true size, plus 4x
    nearest-neighbour magnified crops of the 16px and 32px icons so the
    small toolbar sizes can actually be inspected."""
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


def find_wordmark_font(size: int) -> ImageFont.FreeTypeFont:
    """Return the first available candidate from WORDMARK_FONT_CANDIDATES at
    `size`, or raise a clear error -- never silently drop to Pillow's default
    bitmap font, which does not scale and looks broken at promo-tile size."""
    for candidate in WORDMARK_FONT_CANDIDATES:
        if os.path.exists(candidate):
            return ImageFont.truetype(candidate, size)
    raise RuntimeError(
        "No usable bold TrueType font found for the promo tile wordmark. Tried: "
        + ", ".join(WORDMARK_FONT_CANDIDATES)
        + " -- install one (e.g. `apt-get install fonts-liberation`) and re-run."
    )


# =============================================================== promo tile
def build_promo_tile(character_master: Image.Image) -> Image.Image:
    """Build the 440x280 Chrome Web Store small promo tile.

    Reuses the full Bellhop character render (not the reduced parcel mark --
    at this size the character silhouette reads fine, see the size split
    documented at the top of this file) beside a "Bellhop" wordmark, on a
    flat IDIRA_CHARCOAL background matching the icon set's own palette. No
    third-party name appears anywhere on it, by design (see CLAUDE.md).

    Returns a flat RGB image (no alpha channel) -- store listing surfaces
    render this tile over varying page backgrounds, so a transparent edge
    would show whatever is behind it.
    """
    w, h = PROMO_TILE_SIZE
    tile = Image.new("RGB", (w, h), IDIRA_CHARCOAL)
    draw = ImageDraw.Draw(tile)

    # character_master's own SVG (see svg_character) already fills its full
    # 1024x1024 canvas with IDIRA_CHARCOAL, so pasting the resized render
    # straight onto this same-colour background leaves no seam -- no alpha
    # compositing or rounded-corner mask needed (that treatment is Chrome's
    # app-icon convention, not a promo tile's).
    margin_y = 40
    char_side = h - margin_y * 2
    char_img = character_master.convert("RGB").resize((char_side, char_side), Image.LANCZOS)

    word = "Bellhop"
    font = find_wordmark_font(48)
    bbox = draw.textbbox((0, 0), word, font=font)
    text_w, text_h = bbox[2] - bbox[0], bbox[3] - bbox[1]

    gap = 24
    group_w = char_img.width + gap + text_w
    start_x = (w - group_w) // 2

    char_x, char_y = start_x, (h - char_img.height) // 2
    tile.paste(char_img, (char_x, char_y))

    text_x = char_x + char_img.width + gap - bbox[0]
    text_y = (h - text_h) // 2 - bbox[1]
    draw.text((text_x, text_y), word, font=font, fill=IDIRA_WHITE)

    return tile


def main() -> None:
    os.makedirs(ICONS_DIR, exist_ok=True)

    # Two master renders: the character with its eye glint (used at 128px,
    # where the glint still reads) and without it (used at 48px, where it's
    # too small to read as anything but a stray white speck).
    character_glint = render_svg(svg_character(glint=True))
    character_plain = render_svg(svg_character(glint=False))
    mark = render_svg(svg_mark())

    master_for_size = {
        128: character_glint,
        48: character_plain,
        32: mark,
        16: mark,
    }

    icons: dict[int, Image.Image] = {}
    for size in TARGET_SIZES:
        icon = make_icon(master_for_size[size], size)
        icons[size] = icon
        out_path = os.path.join(ICONS_DIR, f"icon{size}.png")
        icon.save(out_path)
        print(f"wrote {out_path} ({icon.size[0]}x{icon.size[1]}, {ARTWORK_FOR_SIZE[size]})")

    preview = build_preview(icons)
    preview_path = os.path.join(ICONS_DIR, "preview.png")
    preview.save(preview_path)
    print(f"wrote {preview_path} ({preview.size[0]}x{preview.size[1]})")

    os.makedirs(os.path.dirname(PROMO_TILE_PATH), exist_ok=True)
    promo_tile = build_promo_tile(character_glint)
    promo_tile.save(PROMO_TILE_PATH)
    print(f"wrote {PROMO_TILE_PATH} ({promo_tile.size[0]}x{promo_tile.size[1]})")


if __name__ == "__main__":
    main()
