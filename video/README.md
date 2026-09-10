# Bellhop import-flow demo video

Reconstructs the Bellhop import flow (idle -> Preparing... -> confirmation
dialog -> Importing... -> Imported) as a video, for a demo. It is a
**reconstruction**, not a screen recording: real captured DOM/CSS/assets for
the page furniture, with the click/dialog/label sequence scripted on top via
GSAP. It never touches a live tenant.

## What this produces

- `docs/images/import-flow.mp4` — 1920x1080, 30fps, h264, ~10.5s
- `docs/images/import-flow.gif` — 1920x1080, 15fps, ~10.5s

Both are rendered from the same HyperFrames composition at
`video/composition/`.

## Inputs (read-only, do not edit)

- `video/snapshots/marketplace-product-page.html` — a frozen DOM capture of
  the real Idira Marketplace product-info page for "WinSCP - Privilege
  Access Manager SaaS", including the real injected `#bellhop-btn` and the
  real vendor Download button. All CSS (the ~1.3MB stylesheet), fonts, and
  images are inlined as `data:` URIs; any `<script>` is stripped, so the
  page is a static, self-contained DOM snapshot that cannot re-render or
  phone home.
- `video/snapshots/shell-chrome.html` — a frozen fragment of the platform
  shell's left nav rail (`.rail`, 72px wide) and top-right header cluster
  (`.header-cluster`: sparkle/AI button, bell + count badge, Help, avatar +
  name). The marketplace page above renders top-level with no shell around
  it (that's how it was captured), so the shell chrome has to be supplied
  separately and composited alongside it. Real markup, real
  `cyberark-ui-icons-duotone`/`cyberark-ui-icons-stroke` icon fonts (base64
  `@font-face`), real logo/setup-hexagon/sparkle SVGs.

  The header cluster is the real captured `<cyb-user-details-menu>` subtree
  plus the authored CSS rules that match it (pseudo-elements included), not
  a reconstruction. It used to be hand-drawn from measured computed values,
  and that failed repeatedly in ways measuring could not catch: the bell's
  two-tone blue comes from `--color-icon-duotone-stroke` / `-fill` painted
  on `::before`/`::after`, so the `<i>`'s own computed `color` reads a
  misleading grey; and the gap between the avatar and the username is
  produced inside the username box, so the two elements' bounding rects are
  genuinely flush and a margin derived from them is zero. Capture the
  subtree — do not re-derive it from `getComputedStyle`.
  `video/assemble.py` asserts the fragment still contains
  `intercom-notification-count` and `cyb-duotone-icon-notification-02`, so a
  silent regression to hand-drawn markup fails the build.

Both snapshots were captured against a real tenant and **sanitized to the
placeholder tenant `acme-poc`** before being committed — the real tenant
name never appears in either file, in the composition, or in the rendered
output. `video/assemble.py` never modifies these two files; it only reads
them.

## Pipeline

```
video/snapshots/marketplace-product-page.html  ─┐
video/snapshots/shell-chrome.html               ─┼─> video/assemble.py ─> video/composition/index.html
                                                 ─┘
```

`video/assemble.py`:
1. Splices the shell chrome's real `<style>` block (design tokens,
   `@font-face`, `.rail`/`.header-cluster`/`.node-icon`/... rules) into the
   marketplace snapshot's `<head>`, after its own inlined stylesheet, plus
   the plumbing CSS the composition itself needs (sizing, the 72px content
   offset, spinner, cursor).
2. Splices the shell chrome's real `.rail` and `.header-cluster` markup in
   as the first children of the composition root, ahead of the marketplace
   page's own content (which becomes a `left: 72px`-offset frame — 72px is
   the rail's real measured width, so content and rail neither overlap nor
   leave a gap).
3. Appends a synthetic demo cursor and a script that builds the Bellhop
   confirmation dialog from scratch (per the extension's own
   `openConfirmDialog` markup/CSS — this part has no captured snapshot,
   it's authored directly from `extension/content.js`), and a paused GSAP
   timeline driving the whole sequence: idle -> click -> `Preparing…` (with
   the real button's spinner) -> dialog open -> dialog Import click ->
   `Importing…` (no spinner — the real code never re-arms the spinner past
   the first click) -> `Imported ✓`. The trigger button and the dialog's
   Import button positions are measured live via `getBoundingClientRect()`
   against the actual snapshot DOM, not hardcoded, so the cursor always
   lands on the real elements.

No hand-drawn icons or approximated chrome survive in the current version —
every pixel of the sidebar/header comes from the real `shell-chrome.html`
fragment.

## Regenerating

All commands run from the repo root unless noted.

```bash
# 1. Rebuild the composition from the two snapshots (repo-relative paths,
#    safe to re-run any time; only writes video/composition/index.html).
python3 video/assemble.py

# 2. One-time: scaffold the HyperFrames project, if video/composition/
#    doesn't exist yet (it's git-ignored/regenerable, not the snapshots).
cd video
HYPERFRAMES_SKIP_SKILLS=1 npx --yes hyperframes init composition \
  --example blank --non-interactive --skip-transcribe
cd ..
# Gotcha: `hyperframes init` hangs waiting on a prompt unless you pass
# BOTH --non-interactive AND --example blank. Do not use --docker (no
# Docker in this environment).
# Re-run step 1 afterwards — a fresh `init` writes its own placeholder
# index.html that assemble.py needs to overwrite.

# 3. Render both formats.
cd video/composition
npx --yes hyperframes render -o renders/import-flow.mp4
npx --yes hyperframes render -o renders/import-flow.gif --format gif --fps 15
cd ../..

# 4. Publish alongside the docs.
cp video/composition/renders/import-flow.mp4 docs/images/import-flow.mp4
cp video/composition/renders/import-flow.gif docs/images/import-flow.gif
```

`npm run check` (from `video/composition/`) is worth running after any
edit to `video/assemble.py` — it lints the generated composition (GSAP
usage, runtime, layout, motion, contrast). Expect one pre-existing false
positive (`duplicate_media_discovery_risk` on two identical `<img>`
elements) and one info-level font warning for system-fallback font names
in the marketplace snapshot's own font stack (`helvetica neue light`,
`oxygen-sans`, etc.) that were never expected to resolve — both harmless.

## Notes / known limits

- Renders land in `docs/images/` as `import-flow.mp4` / `import-flow.gif`,
  alongside the other extension screenshots documented there.
- `video/composition/` is the HyperFrames project directory (scaffolded by
  `hyperframes init`, then overwritten by `assemble.py`); treat it as a
  build output, not something to hand-edit.
- The confirmation dialog is authored directly from `extension/content.js`
  (see CLAUDE.md's UI spec), not captured — there is no live tenant flow
  that shows it standalone to snapshot.
- The tenant placeholder throughout is `acme-poc` /
  `acme-poc-pcloud.cyberark.cloud`. Never replace it with a real tenant
  name in either snapshot, the composition, or a render.
