#!/usr/bin/env python3
"""Assemble the Bellhop import-flow demo composition.

Splices two READ-ONLY, sanitized (acme-poc) snapshots together into a single
HyperFrames composition:

  video/snapshots/marketplace-product-page.html
      A frozen DOM capture of the real Idira Marketplace product page for
      "WinSCP - Privilege Access Manager SaaS", including the real injected
      #bellhop-btn and the real vendor Download button. All CSS/fonts/images
      are inlined as data: URIs; scripts are neutered so it cannot re-render.

  video/snapshots/shell-chrome.html
      A frozen fragment of the platform shell's left nav rail and top-right
      header cluster (avatar, bell, sparkle, Help) — real markup, real
      cyberark-ui-icons-duotone/stroke icon fonts (base64 @font-face), real
      logo/setup-hexagon/sparkle SVGs. This page renders top-level with no
      shell around it, so the shell chrome has to be supplied separately.

Neither input is modified. This script only reads them and writes the
composed result to video/composition/index.html (a HyperFrames project
scaffolded by `hyperframes init`; see video/README.md).

Usage:
    python3 video/assemble.py
    python3 video/assemble.py --width 1280 --height 720 --out video/composition/index-blog.html
"""
import argparse
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
SNAP_PATH = SCRIPT_DIR / "snapshots" / "marketplace-product-page.html"
SHELL_PATH = SCRIPT_DIR / "snapshots" / "shell-chrome.html"
DEFAULT_OUT_PATH = SCRIPT_DIR / "composition" / "index.html"
DEFAULT_WIDTH = 1920
DEFAULT_HEIGHT = 1080

# Measured from shell-chrome.html's own CSS (`.rail { width: 72px }`) — the
# real rail width. It is an intrinsic width of the captured fragment, not a
# fraction of the canvas, so it does not scale with --width/--height; the
# marketplace content is offset by exactly this much at any canvas size so
# rail and content neither overlap nor leave a gap.
RAIL_WIDTH_PX = 72

# Reference resting position of the synthetic demo cursor before the timeline
# starts moving it, measured against the original 1920x1080 canvas. Scaled
# proportionally for other canvas sizes so the cursor still starts in a
# sensible spot relative to the frame instead of landing off-canvas on a
# narrower render.
CURSOR_START_REF_X = 1180
CURSOR_START_REF_Y = 660


def extract_div(html: str, open_tag_marker: str) -> tuple[str, int, int]:
    """Return (substring, start, end) for the first <div ...> matching
    open_tag_marker through its balanced closing </div>, by depth-counting
    div tags (robust to whitespace, unlike a fixed-offset slice)."""
    start = html.index(open_tag_marker)
    depth = 0
    i = start
    while True:
        next_open = html.find("<div", i)
        next_close = html.find("</div>", i)
        if next_close == -1:
            raise ValueError("unbalanced <div> in fragment")
        if next_open != -1 and next_open < next_close:
            depth += 1
            i = next_open + 4
        else:
            depth -= 1
            i = next_close + len("</div>")
            if depth == 0:
                return html[start:i], start, i


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--width", type=int, default=DEFAULT_WIDTH,
                         help=f"composition canvas width in px (default: {DEFAULT_WIDTH})")
    parser.add_argument("--height", type=int, default=DEFAULT_HEIGHT,
                         help=f"composition canvas height in px (default: {DEFAULT_HEIGHT})")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT_PATH,
                         help=f"output path for the composed HTML (default: {DEFAULT_OUT_PATH})")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    width = args.width
    height = args.height
    out_path = args.out

    # Proportional scale of the cursor's reference resting position, rounded
    # to the nearest px.
    cursor_start_x = round(CURSOR_START_REF_X * width / DEFAULT_WIDTH)
    cursor_start_y = round(CURSOR_START_REF_Y * height / DEFAULT_HEIGHT)

    snap = SNAP_PATH.read_text(encoding="utf-8")
    shell = SHELL_PATH.read_text(encoding="utf-8")

    # ------------------------------------------------------------------
    # Pull the real chrome's <style> block (design tokens, @font-face for
    # the real cyberark-ui-icons fonts, and every .rail/.header-cluster/
    # .node-icon/... rule) and its two real markup fragments (the rail,
    # and the header cluster — NOT the surrounding .content-area, which
    # was only a white background for shell-chrome.html's own standalone
    # preview and is not needed here).
    # ------------------------------------------------------------------
    style_start = shell.index("<style>")
    style_end = shell.index("</style>") + len("</style>")
    shell_style_block = shell[style_start:style_end]

    rail_html, _, _ = extract_div(shell, '<div class="rail">')
    header_cluster_html, _, _ = extract_div(shell, '<div class="header-cluster">')

    # The header cluster is a real captured subtree (`<cyb-user-details-menu>`),
    # not hand-drawn markup, since 2026-09-10. Guard on markers that are
    # actually present in that capture rather than the hand-authored
    # `bell-btn`/`bell-badge` classes it replaced.
    assert "intercom-notification-count" in header_cluster_html, (
        "header cluster fragment is missing the real notification-count marker"
    )
    assert "cyb-duotone-icon-notification-02" in header_cluster_html, (
        "header cluster fragment is missing the real duotone bell-icon marker"
    )

    # ------------------------------------------------------------------
    # 1. Head injection: GSAP + sizing / spinner / cursor CSS + the real
    #    shell-chrome stylesheet, all inserted right before </head>, after
    #    the marketplace snapshot's own inlined stylesheet so ours cascades
    #    last. No hand-drawn chrome CSS survives here — only the plumbing
    #    needed to host the real fragments (offset, stacking, spinner,
    #    cursor) plus the shell fragment's own real <style> block verbatim.
    # ------------------------------------------------------------------
    head_inject = f"""
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style id="hf-plumbing-css">
  html, body {{ width: {width}px !important; height: {height}px !important; overflow: hidden !important; margin: 0 !important; }}
  #hf-root {{ position: relative; width: {width}px; height: {height}px; overflow: hidden; background: #ffffff; }}

  /* Real marketplace content, offset by the real rail width so it neither
     overlaps the rail nor leaves a gap. */
  .hf-marketplace-frame {{ position: absolute; top: 0; left: {RAIL_WIDTH_PX}px; right: 0; bottom: 0; overflow: hidden; background: #ffffff; }}

  /* The shell fragment's own .header-cluster is z-index:1, sized for its
     standalone preview; guarantee it stays above the real page content
     it now floats over. */
  .header-cluster {{ z-index: 5000 !important; }}

  /* ---------- bellhop spinner (verbatim from extension CSS; not present in
     the frozen snapshot since content.js injects it at runtime) ---------- */
  .bellhop-spinner {{ display: inline-block; width: 10px; height: 10px; margin-right: 6px; vertical-align: -1px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; }}
  @media (prefers-reduced-motion: no-preference) {{ .bellhop-spinner {{ animation: bellhop-spin .6s linear infinite; }} }}
  @media (prefers-reduced-motion: reduce) {{ .bellhop-spinner {{ display: none; }} }}
  @keyframes bellhop-spin {{ to {{ transform: rotate(360deg); }} }}
  #bellhop-btn:disabled {{ opacity: 0.55; cursor: not-allowed; }}

  /* ---------- synthetic demo cursor ---------- */
  #cursor {{ position: fixed; top: 0; left: 0; width: 30px; height: 30px; z-index: 999999; pointer-events: none; filter: drop-shadow(0 2px 3px rgba(0,0,0,.45)); will-change: transform; }}
</style>
{shell_style_block}
</head>"""
    assert snap.count("</head>") == 1, "expected exactly one </head>"
    snap = snap.replace("</head>", head_inject, 1)

    # ------------------------------------------------------------------
    # 2. Body: wrap the real <body> tag (the first literal occurrence — a
    #    second, harmless one is plain text inside a trailing CRA
    #    boilerplate HTML comment) with the composition root, the real
    #    rail, the real header cluster, and a positioned frame that the
    #    real marketplace content (everything that follows) drops into.
    # ------------------------------------------------------------------
    body_open = (
        "<body>\n"
        '<div id="hf-root" class="clip" data-composition-id="main" data-start="0" '
        f'data-duration="10.5" data-width="{width}" data-height="{height}">\n'
        + rail_html + "\n"
        + header_cluster_html + "\n"
        + '<div class="hf-marketplace-frame">\n'
    )
    assert snap.count("<body>") == 2, "expected the real <body> plus one literal mention in a trailing comment"
    snap = snap.replace("<body>", body_open, 1)

    # Close the marketplace-frame + hf-root wrappers, add the cursor element
    # and the dialog+timeline script, right before the trailing CRA
    # boilerplate comment that follows the real content.
    cursor_and_script = """
</div>
</div>
<div id="cursor" aria-hidden="true">
  <svg width="30" height="30" viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M2 2 L2 22 L8 17 L12 26 L16 24 L12 15 L20 15 Z" fill="#111827" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/>
  </svg>
</div>
<script>
(function () {
  // ---- Build the confirmation dialog exactly per the Bellhop UI spec ----
  var overlay = document.createElement("div");
  overlay.id = "bellhop-dialog-overlay";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:500000;";

  var dialog = document.createElement("div");
  dialog.id = "bellhop-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "bellhop-dialog-title");
  dialog.style.cssText =
    "--bellhop-accent:#141414;--bellhop-mark:#265bff;background:#ffffff;color:#1a1a1a;border-radius:8px;border-top:4px solid var(--bellhop-accent);padding:24px;max-width:420px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.35);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;box-sizing:border-box;";

  var brandRow = document.createElement("div");
  brandRow.style.cssText = "display:flex;align-items:center;gap:8px;margin:0 0 4px;";
  var brandMark = document.createElement("span");
  brandMark.setAttribute("aria-hidden", "true");
  brandMark.style.cssText = "display:inline-flex;width:18px;height:18px;flex:0 0 18px;";
  brandMark.innerHTML =
    '<svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="9" width="18" height="12" rx="2" fill="var(--bellhop-mark)"/><path d="M3 9 L6 4 L21 4 L18 9 Z" fill="#ffffff" stroke="var(--bellhop-mark)" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  var brandName = document.createElement("span");
  brandName.textContent = "Bellhop";
  brandName.style.cssText =
    "font-size:14px;font-weight:700;color:var(--bellhop-accent);letter-spacing:0.02em;";
  brandRow.appendChild(brandMark);
  brandRow.appendChild(brandName);

  var brandSubtitle = document.createElement("p");
  brandSubtitle.textContent = "Browser extension. Not part of Idira.";
  brandSubtitle.style.cssText = "margin:0 0 16px;font-size:11px;color:#666;";

  var title = document.createElement("h2");
  title.id = "bellhop-dialog-title";
  title.textContent = "Import into Privilege Cloud";
  title.style.cssText = "margin:0 0 16px;font-size:16px;font-weight:600;line-height:1.3;";

  var productLine = document.createElement("p");
  productLine.textContent = "WinSCP - Privilege Access Manager SaaS";
  productLine.style.cssText = "margin:0 0 4px;font-size:14px;font-weight:600;";

  var kindLine = document.createElement("p");
  kindLine.textContent = "PSM connection component";
  kindLine.style.cssText = "margin:0 0 16px;font-size:13px;color:#555;";

  var tenantLabel = document.createElement("p");
  tenantLabel.textContent = "Destination tenant:";
  tenantLabel.style.cssText = "margin:0 0 2px;font-size:12px;color:#555;";

  var tenantValue = document.createElement("p");
  tenantValue.textContent = "acme-poc";
  tenantValue.style.cssText =
    "margin:0 0 4px;font-size:20px;font-weight:700;word-break:break-word;";

  var hostValue = document.createElement("p");
  hostValue.textContent = "acme-poc-pcloud.cyberark.cloud";
  hostValue.style.cssText =
    "margin:0 0 20px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#666;word-break:break-all;";

  var btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";

  var cancelBtn = document.createElement("button");
  cancelBtn.id = "bellhop-dialog-cancel";
  cancelBtn.textContent = "Cancel";
  cancelBtn.style.cssText =
    "padding:8px 16px;border-radius:4px;border:1px solid #ccc;background:#f5f5f5;color:#1a1a1a;cursor:pointer;font-size:14px;";

  var importDlgBtn = document.createElement("button");
  importDlgBtn.id = "bellhop-dialog-import";
  importDlgBtn.textContent = "Import";
  importDlgBtn.style.cssText =
    "padding:8px 16px;border-radius:4px;border:1px solid #0b5fff;background:#0b5fff;color:#ffffff;cursor:pointer;font-size:14px;";

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(importDlgBtn);

  dialog.appendChild(brandRow);
  dialog.appendChild(brandSubtitle);
  dialog.appendChild(title);
  dialog.appendChild(productLine);
  dialog.appendChild(kindLine);
  dialog.appendChild(tenantLabel);
  dialog.appendChild(tenantValue);
  dialog.appendChild(hostValue);
  dialog.appendChild(btnRow);
  overlay.appendChild(dialog);

  // Measure the real, laid-out position of the dialog's Import button
  // without ever letting it paint in the opening frame.
  document.body.appendChild(overlay);
  var dlgImportRect = importDlgBtn.getBoundingClientRect();
  var dialogImportX = dlgImportRect.left + dlgImportRect.width / 2;
  var dialogImportY = dlgImportRect.top + dlgImportRect.height / 2;
  overlay.parentNode.removeChild(overlay);

  // The REAL injected button and its real measured position in the snapshot DOM.
  var triggerBtn = document.getElementById("bellhop-btn");
  var triggerRect = triggerBtn.getBoundingClientRect();
  var triggerX = triggerRect.left + triggerRect.width / 2;
  var triggerY = triggerRect.top + triggerRect.height / 2;

  var cursor = document.getElementById("cursor");
  var CURSOR_TIP_X = 2;
  var CURSOR_TIP_Y = 2;

  function setLabel(btn, text) {
    var label = btn.querySelector(".p-button-label");
    if (label) { label.textContent = text; } else { btn.textContent = text; }
  }
  function addSpinner(btn) {
    if (btn.querySelector(".bellhop-spinner")) return;
    var label = btn.querySelector(".p-button-label");
    var spinner = document.createElement("span");
    spinner.className = "bellhop-spinner";
    spinner.setAttribute("aria-hidden", "true");
    if (label) { btn.insertBefore(spinner, label); } else { btn.appendChild(spinner); }
  }
  function removeSpinner(btn) {
    var sp = btn.querySelector(".bellhop-spinner");
    if (sp && sp.parentNode) sp.parentNode.removeChild(sp);
  }
  function setLoading(btn) {
    btn.disabled = true;
    btn.classList.add("bellhop-btn-loading");
    addSpinner(btn);
    setLabel(btn, "Preparing…");
  }
  function clearLoading(btn) {
    btn.disabled = false;
    btn.classList.remove("bellhop-btn-loading");
    removeSpinner(btn);
    setLabel(btn, btn.dataset.idleLabel || "Import into Privilege Cloud");
  }
  function openDialog() { document.body.appendChild(overlay); }
  function closeDialog() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
  function startImporting(btn) {
    btn.disabled = true;
    setLabel(btn, "Importing…");
  }
  function finishImported(btn) { setLabel(btn, "Imported ✓"); }

  var tl = gsap.timeline({ paused: true });
  tl.set(cursor, { x: __CURSOR_START_X__, y: __CURSOR_START_Y__, scale: 1 }, 0);

  tl.to(cursor, { x: triggerX - CURSOR_TIP_X, y: triggerY - CURSOR_TIP_Y, duration: 1.2, ease: "power2.inOut" }, 0);

  tl.to(cursor, { scale: 0.78, duration: 0.08, ease: "power1.out" }, 1.2);
  tl.to(cursor, { scale: 1, duration: 0.14, ease: "power1.out" }, 1.28);
  tl.call(function () { setLoading(triggerBtn); }, [], 1.2);

  tl.call(function () { clearLoading(triggerBtn); openDialog(); }, [], 2.4);

  tl.to(cursor, { x: dialogImportX - CURSOR_TIP_X, y: dialogImportY - CURSOR_TIP_Y, duration: 1.1, ease: "power2.inOut" }, 2.6);

  tl.to(cursor, { scale: 0.78, duration: 0.08, ease: "power1.out" }, 5.0);
  tl.to(cursor, { scale: 1, duration: 0.14, ease: "power1.out" }, 5.08);
  tl.call(function () { closeDialog(); startImporting(triggerBtn); }, [], 5.0);

  tl.to(cursor, { x: triggerX + 40, y: triggerY + 46, duration: 0.7, ease: "power2.inOut" }, 5.2);

  tl.call(function () { finishImported(triggerBtn); }, [], 8.0);

  window.__timelines = window.__timelines || {};
  window.__timelines["main"] = tl;
})();
</script>
"""

    cursor_and_script = cursor_and_script.replace(
        "__CURSOR_START_X__", str(cursor_start_x)
    ).replace("__CURSOR_START_Y__", str(cursor_start_y))

    anchor = "<!--\n      This HTML file is a template."
    assert snap.count(anchor) == 1, "expected exactly one trailing boilerplate comment anchor"
    snap = snap.replace(anchor, cursor_and_script + anchor, 1)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(snap, encoding="utf-8")
    print(f"wrote {out_path} ({len(snap)} bytes)")


if __name__ == "__main__":
    main()
