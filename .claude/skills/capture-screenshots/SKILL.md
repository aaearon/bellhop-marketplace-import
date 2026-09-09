---
name: capture-screenshots
description: Capture and redact screenshots of the Bellhop extension (the Idira marketplace "Import to Privilege Cloud" button, its confirmation dialog, or any other extension UI) for docs/images/, the README, or a Chrome Web Store / Edge Add-ons listing. Use whenever asked to take, update, refresh, or regenerate screenshots of this extension, to produce store-listing images, or to redact/blur/scrub a tenant name or other sensitive string out of an existing screenshot of this extension. Covers driving Claude in Chrome against a live authenticated tenant, the iframe/DOM limitations that rule out editing the page before capture, and the pixel-level font-matched redaction technique that replaces sensitive text in place instead of blacking it out.
---

# Capture and redact Bellhop screenshots

Hard-won from a live session against `cyberiam-poc`. Every step here exists
because the naive version of it failed once. Don't shortcut them.

## Preconditions - check first, stop early

A capture is impossible without both of these. Check them before touching
the browser tools, and if either is missing, say so and stop rather than
flailing at screenshots of nothing:

1. **The extension is built and loaded unpacked from `extension/`.** Run
   `npm run build` first (compiles `src/` into `extension/lib/`, gitignored
   - without it the service worker fails on import and the extension is
   dead). `chrome://extensions` cannot be reached by the automation tools,
   so you cannot check "is Bellhop installed" directly - infer it instead
   from the injected `#bellhop-btn` next to the vendor's Download button, or
   from Bellhop's own console logs (`bellhop-` prefixed - see CLAUDE.md,
   "General Instructions" commit history) once a marketplace tab is open.
2. **An authenticated `*.cyberark.cloud` tenant tab is open on a marketplace
   product page.** There is no test/staging tenant to fall back to - this
   extension only exists in the context of a live tenant session.

## The iframe constraint

The product page and its "Import to Privilege Cloud" dialog sit inside a
doubly cross-origin iframe: `<t>.cyberark.cloud` -> `<t>-managespace.cyberark.cloud`
-> `<t>-marketplace.cyberark.cloud` (see CLAUDE.md, "Tenant URL structure").
This has concrete tool consequences:

- `read_page` / `find` return only the shell's own accessibility tree. They
  cannot see the dialog, the button, or anything inside the nested iframes.
  Don't spend calls fighting this - it is not a bug you can work around with
  a different selector.
- `javascript_tool` runs in the top frame only, for the same reason. You
  **cannot** edit the dialog's DOM text before capture. This is the actual
  reason redaction has to happen on pixels after the fact, not a stylistic
  choice - record this if asked to justify the approach.
- `computer` screenshots and zooms DO capture the dialog, because it's
  rendered on screen regardless of frame origin.
- `read_console_messages` DOES cross the boundary - `chrome.runtime`
  messages from the content script's isolated-world execution surface
  there regardless of frame origin. Use it for diagnosing extension state,
  not `read_page`.

## Safety rules - non-negotiable

- **Never click the extension's Import button.** It writes into a live
  production tenant. The goal is to capture the confirmation dialog open,
  never to confirm it. Dismiss with Cancel.
- **After any window resize, re-screenshot before clicking anything.**
  Pre-resize coordinates land on the wrong element post-resize - in one
  session this put a click ~37px from Import instead of on Cancel, in a
  live tenant. This is the single most dangerous step in the whole
  procedure; treat a stale coordinate as unusable, always.
- Clicking the **vendor's own** Download button is safe and a useful
  diagnostic (see Troubleshooting below).
- Never trigger a JS `alert`/`confirm`/`prompt` - it blocks the page and the
  automation session.
- Never mutate tenant state otherwise (no imports, no settings changes).

## Capture mechanics

Load the browser tools in one call, not one at a time:

```
ToolSearch query "select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__tabs_close_mcp,mcp__claude-in-chrome__read_console_messages,mcp__claude-in-chrome__read_network_requests"
```

- `computer{action:"screenshot", save_to_disk:true}` - full-page capture,
  returned as a JPEG under `/tmp/claude-chrome-screenshots-*/`. Use for
  wide/whole-page shots. Plain (non-`save_to_disk`) screenshots do **not**
  land in that directory.
- `computer{action:"zoom", region:[x0,y0,x1,y1], save_to_disk:true}` -
  returns a PNG at **native 1:1 CSS-pixel resolution**, not a crop of a
  downscaled screenshot. Use zoom for anything you intend to redact or ship
  tight (e.g. the dialog alone) - the redaction technique below depends on
  working at native resolution.
- The full-page screenshot's coordinate space is **downscaled** from the CSS
  viewport (observed ~0.79x). Zoom region coordinates are given in
  screenshot space but rendered at CSS-pixel resolution in the output -
  sanity-check your capture against a known CSS dimension (e.g. the dialog
  is `max-width:420px`, so a correct 1:1 capture of it measures ~420px
  wide).
- `resize_window` is a dead end for this - capture dimensions changed
  erratically and never landed on a clean 1:1, and every click coordinate
  shifts under it (see the safety rule above). Don't use it. No scrolling
  is needed either: the dialog is `position:fixed` and centred.
- `save_to_disk:true` is sometimes blocked by the permission classifier on
  the first one or two attempts and then succeeds identically on retry.
  Retry the same call; don't go looking for a workaround.
- Call `read_network_requests` **before** the action you want to observe -
  it only starts capturing from when it's first called.
- Reloading the page clears the console. Read `read_console_messages`
  *before* you reload, or evidence of an earlier failure is gone.
- Only one dialog opens at a time (`dialogOpen` guard in `content.js`) - a
  second Import click while one is open is a no-op, not a second dialog.
- Live page chrome unrelated to Bellhop (e.g. an Intercom toast,
  bottom-right) can appear in full-page shots - crop it out or dismiss it.

## Troubleshooting: a blank/error dialog is probably a stale session, not a bug

`GET /api/downloads/integrations/<uuid>` returning **401** means the SSO
session has gone stale, not that the extension is broken. Before assuming
you found a real bug: click the **vendor's own** Download button (safe, see
Safety rules) and see if it also fails. If it does, hard-refresh the tenant
tab and retry the capture. If only Bellhop's request fails, that's a real
finding, not a session issue.

Check the dialog for a red `Cannot import: <reason>` line *before* investing
further in a capture from that state - it means the presigned-download-url
fetch already failed (see CLAUDE.md, "Sequencing"), and no amount of
retrying the screenshot fixes that; go fix the underlying fetch first (most
often: the stale-session case above).

**Never deliver a screenshot of an error state for docs/README/store use.**
A screenshot showing the product failing is worse than no screenshot at
all - this happened once already (a stale-session 401 produced a batch of
unusable images). Catch it before capture (the red error line) and after
(read the image yourself - see Verification).

## Redaction

The tenant name is sensitive and appears in the confirmation dialog's
destination block (both bare, e.g. `acme-poc`, and as
`acme-poc-pcloud.cyberark.cloud`), and can appear elsewhere in page chrome.
Screenshots from these tools are viewport-only - no OS window chrome,
address bar, or tab strip - which structurally rules out a whole class of
leak (no bookmarks bar, no other-tab titles) before you even start.

**Method: replace the text in place, font-matched, not a black bar.**
`scripts/redact.py` implements the three steps below - import it rather
than re-deriving this from scratch:

1. **Locate the ink.** `ink_bbox(img, region)` thresholds on
   `RGB.sum() < 700` and returns the tight box around dark pixels. Restrict
   `region` to the dialog's interior: the modal's own border/shadow reads as
   a constant false floor of dark pixels near the edges and inflates every
   measurement if you don't. Do this on the native 1:1 `zoom` capture, never
   on a downscaled screenshot.
2. **Identify the real font, don't eyeball it.** `best_fit(img, region,
   original_text, candidates, sizes)` sweeps candidate fonts/sizes,
   confirming each cheaply on ink-width match first (`font.getbbox(text)`
   width vs. the measured ink width, a couple of px tolerance) before doing
   a full render-and-compare pass. It scores each surviving candidate by
   IoU (pixel overlap) between the real ink and a fresh render of the same
   *original* sensitive text in that candidate font - never render the
   replacement text for scoring, only the real string you can still read.
   **Font source matters and is not portable.** On a WSL2 host, Chrome
   renders with the underlying **Windows** fonts
   (`/mnt/c/Windows/Fonts/*.ttf`), not whatever Linux's `fc-list` offers -
   DejaVu was tried as a candidate here and scored badly, because it's
   simply the wrong typeface family. The Bellhop dialog matched **Segoe UI
   Bold** (destination tenant line) and **Consolas** (the pcloud host line,
   monospace). On Linux-native Chrome, build your candidate list from
   `fc-list` instead and expect a different answer - recalibrate, don't
   reuse the WSL2 result.
   Treat IoU **below ~0.6 as a wrong font or size** - widen the candidate
   list or size range and retry rather than shipping it. IoU **0.75-0.9 is
   the realistic ceiling** even for a genuinely correct match, because
   Chrome's own antialiasing is heavier than Pillow's rasterizer - don't
   chase 1.0.
3. **Recover the draw origin, not the ink box.** `origin_for(font,
   original_text, ink_topleft)` backs out the anchor point (`getbbox()`
   offset subtracted from the measured ink top-left) that the browser
   actually drew from. Reuse that exact origin point to draw the
   *replacement* text. Do **not** align bounding boxes between the original
   and replacement strings directly - different strings have different
   ascenders/descenders, and box-aligning shifts the visible baseline in a
   way that reads as subtly wrong even when everything else matches.
   `best_fit` also fine-tunes this origin in 0.5px steps (Pillow's FreeType
   backend rasterizes fractional coordinates natively - confirmed, don't
   supersample-and-downscale to fake it, that softens edges enough to
   understate the real ink count by ~3x and was tried and rejected here).
4. **Colour comes from the source, not a pixel sample.** Read the actual
   colour off `extension/content.js`'s dialog CSS. Sampling a pixel next to
   antialiased text gives a washed-out, wrong grey.
5. **Erase, then redraw.** `redact(img, erase_box, font, origin,
   replacement_text, text_color, bg_color)`. Pad `erase_box` generously
   above/below the measured ink to clear ascenders and descenders in full -
   but check with `inspect_3x()` (saves a 3x NEAREST-upscaled crop) that the
   pad doesn't bleed into a neighbouring line, both before erasing (to see
   the true extent) and after drawing (to catch a misaligned baseline or
   wrong weight that OCR alone would miss).

Fall back to a plain black rectangle (`black_bar` in the same script) only
when no candidate font clears a reasonable IoU - e.g. text over a busy
background/gradient where font-matching genuinely can't work. **Declare it**
in your verification report when you do; it is not the default and should
be visibly rare.

**Store variant: redact once, reuse the pixels.** Never redact the
1280x800/640x400 store image separately from the full-size original -
scaling reuses the already-redacted region rather than re-running
redaction, so the two images cannot drift out of sync (different font
match, only one actually clean, etc). Concretely: redact on the native 1:1
crop, downscale that patch, and paste it back into the full-page image at
the exact region `zoom` captured; only then run `scripts/pad_to_store.py`
(fit `s = min(1280/w, 800/h)`, LANCZOS, centred on white `#ffffff` -
padding lands top/bottom for a wide capture, left/right for a tall one) on
the already-clean result.

## Verification - mandatory, not skippable

- **Re-open and visually read every finished image yourself, after
  redaction** - not just the raw capture, and not only via OCR. OCR misses
  a misaligned baseline or wrong font weight that your own eyes catch
  instantly.
- **Run OCR and grep case-insensitively for the sensitive string, per
  image**, with `scripts/verify_ocr.sh IMAGE.png PLACEHOLDER forbidden...`.
  It does two things a single grep doesn't:
  - Checks **both** the raw image and a 3x upscale. At native/downscaled
    (e.g. 1280x800) resolution, `tesseract` failed to resolve dialog body
    text entirely in testing and returned empty output - which reads as a
    false PASS on the negative check unless you also try the upscale. Trust
    the upscaled result; a 1x "found nothing" alone is not sufficient.
  - Requires a **positive** control too: the placeholder (`acme-poc`) must
    actually read back via OCR, not merely have the real name be absent.
    This catches a redaction that looks right by eye but rendered garbled
    or invisible. The monospace host line in particular can OCR garbled
    even when the redaction is correct - which is exactly why the positive
    control matters more than a clean negative alone.
- Report **per image** what was checked and what was found.
- **Never deliver an image that has not been personally re-read.** If an
  image can't be made safe (redaction won't hold up, or it's an error
  state - see Troubleshooting), delete it and say why, rather than shipping
  a caveat.

## Output conventions

- PNGs into `docs/images/`, kebab-case descriptive names
  (`import-confirm-dialog.png`, not `screenshot1.png`).
- Full-size capture plus a 1280x800 store-ready variant (Chrome Web Store
  and Edge both also accept 640x400) via `scripts/pad_to_store.py` - padded
  onto a neutral background, never stretched/distorted.
- The approved placeholder for this project is `acme-poc` /
  `acme-poc-pcloud.cyberark.cloud`, matching `test/tenant.test.ts` and
  `test/origins.test.ts`. Don't invent a different placeholder.

## Scripts

- `scripts/redact.py` - `ink_bbox`, `origin_for`, `best_fit`, `redact`,
  `inspect_3x`. Import these into a short driver script per image; each
  sensitive line typically needs its own region/font/size, so this is a
  toolkit, not a one-shot CLI.
- `scripts/pad_to_store.py` - fit-and-pad an already-redacted image onto a
  1280x800 or 640x400 canvas. CLI: `python3 pad_to_store.py IMAGE.png --out
  OUT.png [--size 1280x800] [--bg r,g,b]`.
- `scripts/verify_ocr.sh` - mandatory post-redaction check. CLI:
  `verify_ocr.sh IMAGE.png PLACEHOLDER forbidden1 [forbidden2 ...]`.
