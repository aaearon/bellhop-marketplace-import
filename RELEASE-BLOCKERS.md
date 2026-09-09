# Release Blockers

What stands between this spike and a public Chrome Web Store release, grouped by severity. Each item states the risk — what breaks if it ships unfixed.

## Blockers — must fix before any public release

- [ ] **Trademark — nominative fair use, needs counsel review before public distribution.** "Idira" appears descriptively in the extension's description and README (naming the marketplace it imports from), with a non-affiliation disclaimer — that descriptive use still needs a counsel pass before public distribution. Separately unresolved: the extension automates the vendor's admin UI without vendor sanction. Strategic risk: a vendor-shipped native "Install" action would make this extension redundant.
- [ ] **SRS platform variant never tested.** Code routes `CPM|SRS → /Platforms/Import`, claiming support for both, but only the CPM variant has been exercised. Risk: shipping a claimed capability that may fail against real SRS data.
- [ ] **Non-super-admin users never tested.** Every verification run so far used maximum rights. Risk: the extension may fail, partially fail, or behave unpredictably for the majority of real users who are not super admins — untested against the platform's own permission model.
- [x] ~~**Privacy policy and permission justifications — drafted, not finalised.**~~ — **resolved.** `docs/PRIVACY.md` and `docs/STORE-PERMISSIONS.md` are finalised, covering every declared permission and host pattern. Still to do: host the policy at a public URL and paste it into both store dashboards.
- [x] ~~**Distribution method undecided.**~~ — **decided: submit to the Chrome Web Store and Microsoft Edge Add-ons.** Edge needs no porting; one package and manifest serve both (see "Browser support" in `CLAUDE.md`). Listed vs. unlisted/hidden is still open. Load-unpacked remains the dev path; enterprise force-install from a self-hosted update URL stays available for tenants that disable developer mode.

## Should fix

- [ ] **Large artifacts vs. service worker idle lifetime.** Only a 308 KB artifact has been tested against the ~30s MV3 service worker idle timeout. Risk: a larger artifact's fetch + base64 encode gets killed mid-flight, failing imports for bigger components with no clear cause. Mitigation: an offscreen document.
- [ ] **Two tenants authenticated at once, never exercised live.** The CSRF cookie scope-ranking (`findXsrfCookie` in `src/csrf.ts`) was written specifically for this case but has never been run against two live authenticated tenants. Risk: the one scenario the ranking logic exists to handle is unverified in practice.
- [x] ~~**Raw HTTP response bodies rendered into the page DOM.**~~ — **resolved for the observed case.** A duplicate import returned `HTTP 409 - {"ErrorCode":"CAWS00001E",...}`, truncated mid-sentence in the button label. A 409 now reads "Already imported into this tenant"; raw status and body go to the console only. Every other status still renders as raw `HTTP <status> - <body>`, so the risk stands for any status not yet seen.
- [ ] **No fetch timeouts.** Neither the S3 fetch nor the import POST has a timeout. Risk: a hung request leaves the button reading "Importing…" indefinitely, with no way for the user to know it failed or retry.
- [x] ~~**No CI.**~~ — **resolved for build and test.** `.github/workflows/ci.yml` runs typecheck, tests and build, and verifies every `src/` module produced a compiled counterpart in `extension/lib/` — the exact failure that silently dropped `csrf.ts` before. Still missing: no ESLint/Prettier config, which remains a stated project convention.
- [ ] **No test coverage for `extension/content.js` or `extension/background.js`.** Only the pure `src/` modules are unit-tested; the DOM/network paths are validated manually only. Risk: the highest-risk, most-changed code paths have no regression safety net. The origin-allowlist check now lives in `src/origins.ts` and is unit-tested.
- [x] ~~**Packaging does not exclude `recon/`.**~~ — **resolved: `recon/` deleted from the repository**, not merely excluded from packaging. It redacted query-string values (including the presigned S3 link's embedded AWS credentials) before logging, and was removed once API discovery was complete.
- [ ] **No versioning or release process.** Icon set exists (`extension/icons/`, the Bellhop mascot). Still missing: the version is hand-edited in `extension/manifest.json` and `package.json` with nothing enforcing they stay in sync, and there is no tag/release workflow. Risk: no way to distinguish or roll back releases once published.

## Optional / later

- [ ] **Ephemeral host grants — deferred, not rejected.** `chrome.permissions.remove()` after each import would turn a grant that lasts until manually revoked into one lasting a few seconds, and with the `cookies` permission gone would leave the extension holding nothing at all in its steady state. Deferred because it kills the `alreadyGranted` fast path: every import would show the native Chrome prompt, not just the first into a tenant. That may still be the right trade for a tool that writes into a PAM tenant — the prompt is the security boundary — but it is a user-visible behaviour change, so it is a deliberate decision rather than an oversight. If built, revoke only after the response is read, and add a `chrome.runtime.onStartup` sweep so a worker killed mid-import cannot leak a grant across a restart.
- [ ] Link to the imported item in Privilege Cloud from the success state.
- [ ] Firefox port.
- [ ] Localisation of the extension's own strings.
- [x] ~~"Already installed?" pre-flight check~~ — **decided: do not build.** Tenant-side lookups exist (`GET /PasswordVault/API/ConnectionComponents/{id}` returns the id or null; `GET /PasswordVault/API/Platforms/{PlatformID}` returns `PluginVersion`), but the marketplace payload carries only a marketplace-internal UUID and display name — no `PlatformID`/`ConnectionComponentID`, no shared naming scheme, and versions on different axes (`latestVersion: "20"` vs `PluginVersion: "21.0.1"`). Matching would be fuzzy-on-name; a false "already installed" would block a legitimate import or misrepresent a production tenant. Revisit only if the marketplace API exposes a tenant-shaped identifier.

## Verified working

- Injection anchors on `data-testid="item-download"`, falling back to the `cyb-icon-download-*` icon class, then a structural anchor, then text. Residual risk: a vendor redeploy renaming both the test id and the icon class drops it to the fragile text match.
- Artifact origin is derived from the download URL at runtime and requested per-host; no vendor-internal bucket name is baked into the manifest.
- End-to-end import of a PSM connection component on a CPM tenant as super admin, including the confirmation dialog, per-tenant optional permission grant, and CSRF handling.
- Duplicate import is refused, not silently overwritten: `HTTP 409`, `ErrorCode CAWS00001E`. The existing failure path surfaces it, so no pre-flight check is required.
- 86 unit tests over the pure modules (`base64.ts`, `csrf.ts`, `tenant.ts`, `classify.ts`, `origins.ts`), including the origin allowlist that gates permission requests.
