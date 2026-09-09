# Release Blockers

What stands between this spike and a public Chrome Web Store release, grouped by severity. Each item states the risk — what breaks if it ships unfixed.

## Blockers — must fix before any public release

- [ ] **Trademark and vendor sanction.** The extension is named "Idira Marketplace Importer" and automates the vendor's admin UI without vendor sanction. Risk: this is a legal question, not an engineering one — trademark use for an unsanctioned integration can get the listing pulled or draw a cease-and-desist. Strategic risk alongside it: if the vendor ships a native "Install" action, this extension becomes redundant.
- [ ] **SRS tenants never tested.** The code routes `CPM|SRS → /Platforms/Import` and thereby claims SRS support, but only a CPM platform path has ever been exercised. Risk: shipping a claimed capability that may fail against real SRS data.
- [ ] **Non-super-admin users never tested.** Every verification run so far used maximum rights. Risk: the extension may fail, partially fail, or behave unpredictably for the majority of real users who are not super admins — untested against a PAM product's permission model.
- [ ] **Button injection anchors on literal text "Download".** `findDownloadButton` in `extension/content.js` keys off the button's visible text, not a stable selector. Risk: any localisation or vendor copy change silently removes the Import button with no error, no warning, no telemetry.
- [ ] **Missing Chrome Web Store privacy policy and permission justifications.** The store requires a privacy policy and a written justification per requested permission. `cookies`, requested against a privileged-access-management domain, will draw particular reviewer scrutiny. Risk: submission rejected or delayed at review.

## Should fix

- [ ] **Large artifacts vs. service worker idle lifetime.** Only a 308 KB artifact has been tested against the ~30s MV3 service worker idle timeout. Risk: a larger artifact's fetch + base64 encode gets killed mid-flight, failing imports for bigger components with no clear cause. Mitigation: an offscreen document.
- [ ] **Two tenants authenticated at once, never exercised live.** The CSRF cookie scope-ranking (`findXsrfCookie` in `src/csrf.ts`) was written specifically for this case but has never been run against two live authenticated tenants. Risk: the one scenario the ranking logic exists to handle is unverified in practice.
- [ ] **Raw HTTP response bodies rendered into the page DOM.** A duplicate import shows `HTTP 409 - {"ErrorCode":"CAWS00001E","ErrorMessage":"Creation of connection component PSM-SQLDeveloper failed. Reason: connection` — truncated mid-sentence. A 409 should read "Already imported into this tenant", with detail in the console. Risk: unsanitised, non-human-readable server output shown directly in a PAM product's UI.
- [ ] **No fetch timeouts.** Neither the S3 fetch nor the import POST has a timeout. Risk: a hung request leaves the button reading "Importing…" indefinitely, with no way for the user to know it failed or retry.
- [ ] **No CI.** Nothing runs `tsc` or `vitest` automatically; no ESLint/Prettier config exists despite being a stated project convention. Risk: a regression or type error ships unnoticed; style drifts with no enforcement.
- [ ] **No test coverage for `extension/content.js` or `extension/background.js`.** Only the pure `src/` modules are unit-tested; the DOM/network paths are validated manually only. Risk: the highest-risk, most-changed code paths have no regression safety net. (The origin-allowlist security check is being moved into `src/` with tests in a parallel task.)
- [ ] **Packaging does not exclude `recon/`.** `recon/` is a MAIN-world diagnostic observer that logs full request URLs, including presigned S3 URLs carrying live AWS credentials in the query string. Risk: shipping it in a store package leaks a live diagnostic/logging tool (and potentially credential-bearing URLs) to end users.
- [ ] **No extension icons; version is a static `0.1.0`.** No icon set, no versioning or release process. Risk: unpolished/rejected store listing, and no way to distinguish or roll back releases once published.

## Optional / later

- [ ] Link to the imported item in Privilege Cloud from the success state.
- [ ] Firefox port.
- [ ] Localisation of the extension's own strings.
- [x] ~~"Already installed?" pre-flight check~~ — **decided: do not build.** The tenant-side lookups are good (`GET /PasswordVault/API/ConnectionComponents/{id}` returns the id or null; `GET /PasswordVault/API/Platforms/{PlatformID}` returns `PluginVersion`), but the marketplace payload carries only a marketplace-internal UUID and a display name, with no `PlatformID`/`ConnectionComponentID` and no relationship between the naming schemes. Matching would be fuzzy-on-name, and a false "already installed" would either block a legitimate import or misrepresent a production tenant. Versions are also on different axes (`latestVersion: "20"` vs `PluginVersion: "21.0.1"`). Revisit only if the marketplace API ever exposes a tenant-shaped identifier.

## Verified working

- Artifact origin is derived from the download URL at runtime and requested per-host; no vendor-internal bucket name is baked into the manifest.
- End-to-end import of a PSM connection component on a CPM tenant as super admin, including the confirmation dialog, per-tenant optional permission grant, and CSRF handling.
- Duplicate import is refused, not silently overwritten: `HTTP 409`, `ErrorCode CAWS00001E`. The existing failure path surfaces it, so no pre-flight check is required.
- 83 unit tests over the pure modules (`base64.ts`, `csrf.ts`, `tenant.ts`, `classify.ts`, `origins.ts`), including the origin allowlist that gates permission requests.
