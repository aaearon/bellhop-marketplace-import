# CLAUDE.md

## What this is

Idira Marketplace Importer is a Chrome MV3 extension spike: it adds an
"Import to tenant" button beside the "Download" button on Idira marketplace
product pages. Instead of downloading the artifact zip and hand-uploading
it, the button imports it directly into the same tenant's Privilege Cloud.
Supports both connection components and platforms (see Classification
below). Confirmed working end-to-end against a live tenant
(`acme-poc`), for a single connection-component product, as a super
admin.

"Idira" is Palo Alto Networks' rebrand of CyberArk. Product docs live at
docs.cyberark.com. The public marketplace is marketplace.idira.pan.dev.

## Tenant URL structure

The tenant UI is a shell page wrapping nested, cross-origin iframes. The
address bar always shows the shell URL regardless of which iframe is
active — it is not a reliable indicator of what's actually loaded. For a
tenant `<t>`:

- Shell: `https://<t>.cyberark.cloud/` (routes `/adminportal/...`,
  `/privilegecloud`)
- Marketplace SPA: `https://<t>-marketplace.cyberark.cloud/`
- PasswordVault: `https://<t>-pcloud.cyberark.cloud/PasswordVault/`

All same-site (`cyberark.cloud`), all cross-origin. The marketplace SPA
refuses to render as a top-level page ("You're missing the right
permissions") — it must be framed by the shell, so it cannot be developed or
tested standalone.

## Architecture

```
content script (marketplace iframe)
  -> GET /api/downloads/integrations/<uuid>   (same-origin, cookies)
  -> presigned S3 url
  -> chrome.runtime.sendMessage
service worker
  -> fetch S3 bytes                            (CORS-exempt, no cookies)
  -> arrayBufferToBase64
  -> POST <t>-pcloud.cyberark.cloud/.../{ConnectionComponents,Platforms}/Import  (cookies)
  -> result relayed back to content script, button label updated
```

The fetch/POST split across two contexts is required, not stylistic: a
content script is not CORS-exempt, but an MV3 service worker with
`host_permissions` is. The S3 fetch and the import POST both have to happen
in the service worker (`extension/background.js`); the button and page
inspection live in the content script (`extension/content.js`).

## Marketplace API

Relative to the marketplace iframe origin:

- `GET /api/integrations/<uuid>` — product detail, used to classify the
  product and gate the button (see Classification below).
- `GET /api/integrations/<uuid>/versions`
- `GET /api/downloads/integrations/<uuid>` — returns
  `{url, expiresAt, expiresIn: 600, fileName: null, sha256: ""}`. `url` is a
  presigned AWS S3 link (600s TTL) on an origin outside `cyberark.cloud`.
  `fileName`/`sha256` are empty in practice — there is no integrity check
  available from this endpoint. Do not add a fake one.

## Classification

The marketplace product JSON has no explicit package-type field, and
`category` is not usable — observed values are inconsistent between products
of the same kind (e.g. two different connection components have different
`category` strings). The reliable discriminator is the top-level
`idiraServices` array, implemented in `src/classify.ts`
(`classifyProduct`/`importPathFor`, compiled to `extension/lib/classify.js`
for `background.js` to import):

- `hasArtifact !== true`, or `idiraServices` missing/not an array → not
  importable (null).
- `idiraServices` contains `"PSM"` → connection component.
- `idiraServices` contains `"CPM"` or `"SRS"` → platform.
- Contains both a PSM marker and a CPM/SRS marker → ambiguous, fails closed
  (null), logged clearly. Not observed in real data; would likely be a
  bundled package needing two imports in some order, out of scope.
- Neither marker present → null.

`extension/content.js` cannot use ESM imports, so it sends the fetched
product detail to the service worker (`{type: "classify", detail}`) and gets
the classified kind back rather than duplicating this logic.

## Import endpoint

Body and auth are identical for both kinds:
`Content-Type: application/json`, body
`{"ImportFile": "<base64 of raw zip bytes>"}`, `credentials: "include"`, plus
the CSRF headers below. Only the path differs, chosen by `importPathFor`:

- connection component:
  `POST https://<t>-pcloud.cyberark.cloud/PasswordVault/API/ConnectionComponents/Import`
- platform:
  `POST https://<t>-pcloud.cyberark.cloud/PasswordVault/API/Platforms/Import`

The connection-component path is confirmed working end-to-end; the platform
path follows the same contract but has not yet been confirmed against a live
tenant.

The artifact zip is JAR-signed (`META-INF/*.SF`, `*.RSA`) with the component
definition (`CC-*.xml` for connection components) and binaries at the root.
It is directly importable, not a wrapper, and must be transmitted
byte-for-byte — any unzip/re-zip breaks the signature. This is why the code
never opens the zip; it only checks the two-byte `PK` magic header before
forwarding it.

## Confirmation dialog

Clicking "Import to tenant" opens a DOM confirmation dialog (built inline in
`content.js`, not `window.confirm`) instead of importing immediately; only
its Import button starts the request. It names the product, the kind, and
the destination tenant/host before any write happens. This exists because
implementation partners are authenticated to multiple customer tenants at
once, and the destination is derived silently from the page origin
(`deriveOrigins`, returned alongside `kind` from the `classify` message) —
without this step, nothing distinguishes an import into `acme` from one into
`acme-uat`.

## Auth

The service worker's `fetch` with `credentials: 'include'` plus
`host_permissions` carries the tenant session cookie — Chrome treats
extension-initiated requests as same-site when the extension holds host
permissions for the target. This alone gets the session cookie accepted by
the PAM API: the first import attempt without a CSRF header returned
`HTTP 400 - CSRF validation failed`, not a 401/403, confirming the cookie
was accepted and only the double-submit CSRF token was missing.

CSRF is required, and `src/csrf.ts` is wired into `extension/background.js`.
The worker reads the token with
`chrome.cookies.getAll({ url: origins.pcloudOrigin })` — the `url` form,
because the token cookie may be scoped to `.cyberark.cloud` rather than the
pcloud host — and selects the `XSRF-TOKEN-<guid>` cookie via
`findXsrfCookie()`. `extension/manifest.json` requires
`"permissions": ["cookies"]` for this.

Open question: the correct request header **name** is still unknown. The
code sends the token under both `X-XSRF-TOKEN` and `X-<cookie name>` (e.g.
`X-XSRF-TOKEN-<guid>`), since an extra unrecognized header is harmless but a
missing one fails the request. It works, but which header the server
actually honours is unconfirmed — narrow it by removing one header at a
time and re-testing.

## Known limitations

- Connection components and platforms only (see Classification). The button
  fails closed (does not appear) on any product `classifyProduct` doesn't
  recognize, including a bundled product whose `idiraServices` carries both a
  PSM marker and a CPM/SRS marker — out of scope, would need two imports in
  some order.
- Verified only as a super admin, on one connection-component product. A
  lesser-privileged admin, and the platform import path, are untested.
- Duplicate/re-import behavior is untested.
- A 200 from the import endpoint has not been confirmed to mean the
  component actually functions afterward — only that the POST succeeded.
- The injection anchor (`findDownloadButton` in `extension/content.js`) keys
  off the Download button's visible text, not a stable selector, because
  Angular's `_ngcontent-*` attributes are build-hash dependent. A vendor
  frontend redeploy can break this silently.
- The service worker has a ~30s idle lifetime; the one artifact tested was
  308 KB. A much larger artifact may need an offscreen document to survive
  the fetch + base64 encode.
- Product type is inferred, not declared (see Classification). This is a
  heuristic derived from two observed payloads and may misclassify a shape
  not yet seen.
- This is an unsupported integration against a vendor UI. If the vendor
  ships a native "Install to this tenant" action, this becomes redundant.

## Future direction

The Idira Marketplace carries integrations for all Idira products, not just
Privilege Cloud, so this extension may later target other Idira services.
The design already accommodates that additively: `classifyProduct`/
`importPathFor` (`src/classify.ts`) map an `idiraServices` marker to a
destination, and `deriveOrigins` already derives per-service hosts from the
tenant name, so adding a service would mean a new mapping plus a host, not a
rewrite. Current scope remains exactly PSM connection components and
CPM/SRS platforms, both on Privilege Cloud.

## Conventions

- TypeScript `strict` for `src/` (compiled to `extension/lib/` for the
  service worker to import as an ES module). The content script and service
  worker source files under `extension/` are plain JS: content scripts
  cannot use ESM imports, so `content.js` is a single IIFE; `background.js`
  is a module worker and imports from `extension/lib/`.
- No bundler. `npm run build` runs `tsc -p tsconfig.build.json`
  (`include: ["src"]`), compiling all of `src/` into `extension/lib/`
  (gitignored) as ES modules for `background.js` to import. Convention:
  anything under `src/` that the extension imports must be covered by that
  `include` — listing individual files instead of the `src` directory
  silently omits new ones (no compile error, only a runtime
  module-not-found in the service worker), which is what happened to
  `csrf.ts` before this was fixed.
- Tests: vitest, `npx vitest run` (or `npm test`). Pure functions
  (`base64.ts`, `csrf.ts`, `tenant.ts`, `classify.ts`) are unit-tested. Test
  files use the `*.test.ts` suffix (vitest's default include pattern) so
  `npx vitest run` picks them up with no config. DOM/network paths in
  `extension/content.js` and `extension/background.js` are not — they were
  validated manually against a live tenant.
- Chrome match patterns cannot express a partial subdomain wildcard —
  `https://*-marketplace.cyberark.cloud/*` is rejected as an invalid host
  wildcard. `extension/manifest.json` matches the broad
  `https://*.cyberark.cloud/*` and `content.js` narrows to the marketplace
  host by regex on its first line, so it no-ops in every other iframe.

## recon/

`recon/` is a throwaway, MAIN-world diagnostic extension used to discover the
iframe API calls above — tab-level network capture does not see fetch/XHR
originating inside cross-origin iframes; only a content script with
`all_frames: true` does.

Security caveat: `recon/observer.js` logs full request URLs, and the
presigned S3 download URL carries live AWS credentials in its query string.
Unload `recon/` when not actively diagnosing, and redact query-string values
if it's ever reused.
