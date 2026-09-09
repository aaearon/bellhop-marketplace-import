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
content script is not CORS-exempt, but an MV3 service worker holding a host
permission for the target is. The S3 fetch and the import POST both have to
happen in the service worker (`extension/background.js`); the button and page
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

## Permissions

The extension installs with **no host access and no cookie reach**.
`extension/manifest.json` declares both host patterns under
`optional_host_permissions`, never `host_permissions`. `"permissions":
["cookies"]` stays declared but is inert on its own: `chrome.cookies` can
only reach hosts the extension currently holds a host permission for, so
narrowing host permissions transitively narrows cookie reach.

This matters because the extension sits next to a PAM product.
`*.cyberark.cloud` + `cookies` as a standing install-time grant means read
access to the session cookie of every customer tenant a partner is signed in
to, forever. Optional permissions make that grant per-tenant, explicit, and
revocable.

`content_scripts.matches` is unaffected and stays broad: a declared content
script runs without any host permission, and its same-origin fetches
(`/api/integrations/...`, `/api/downloads/integrations/...`) need none
either. Only the service worker's cross-origin fetches and `chrome.cookies`
need host access, and both happen after a user click.

The dialog's Import button requests the **exact** origins for that tenant —
`https://<t>-pcloud.cyberark.cloud/*` (built from the `pcloudOrigin` the
classify response already returns) plus the S3 bucket origin — never a
wildcard. `chrome.permissions.contains()` runs first, so a repeat import into
an already-granted tenant does not re-prompt. Decline or error fails closed:
the button reads `Failed: permission not granted` and nothing else is tried.

`chrome.permissions` is a `privileged_extension`-context API (Chromium
`extensions/common/api/_api_features.json`), so it is **undefined in a content
script**. Both calls therefore happen in the service worker, reached by
`chrome.runtime.sendMessage`, and no extension page is involved:

- `permissionsContains` — no user gesture required, so it is asked early, in
  the same async flow that classifies the product (`checkProductKind`), and its
  answer is cached on the classification as `alreadyGranted`.
- `permissionsRequest` — `chrome.permissions.request()` runs directly in the
  service worker's `onMessage` handler. Chromium attaches the content script's
  `HasTransientUserActivation()` to the outgoing message
  (`messaging_util.cc`), carries it across the hop as the `user_gesture` bit on
  the `Message` struct (`message_port.mojom`), and wraps the worker's
  `onMessage` dispatch in an interaction scope when that bit is set
  (`native_renderer_messaging_service.cc`); `PermissionsRequestFunction::Run()`
  gates only on `user_gesture()`, with no context-type check
  (`permissions_api.cc`). Confirmed against current Chromium source, not a bug
  tracker entry.

**The constraint this imposes is sequencing.** The interaction scope covers
only the *synchronous* dispatch, so:

- `content.js`'s click chain (Import button listener → `onImport` → `close()` →
  `handleImportClick`) contains **no `await` and no promise hop** before the
  `sendMessage`. `handleImportClick` is deliberately not `async`; the async
  work moved to `runImport`, called afterwards. Front-loading `contains()` is
  what makes this possible.
- `background.js` handles `permissionsRequest` as the **first** branch of the
  listener, validates synchronously, and calls `request()` in its callback
  form. No `await` precedes it.

The requested origins are validated in the service worker before `request()` is
called: each pattern must be exactly the S3 bucket, or match
`/^https:\/\/[a-z0-9.-]+-pcloud\.cyberark\.cloud\/\*$/` (the `*` sits outside
the character class so no host-wildcard pattern matches). Anything else is
refused with `unexpected origin requested` and `request()` is never reached.
This keeps a buggy or compromised caller from using the extension to solicit the
wildcard `https://*.cyberark.cloud/*` that `optional_host_permissions` declares
— i.e. every tenant at once.

There is deliberately no settings page, no permission-management UI and no
"grant all tenants" convenience. Granted origins are visible and individually
revocable under Site access in `chrome://extensions`.

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

The service worker's `fetch` with `credentials: 'include'` carries the tenant
session cookie once the tenant's host permission has been granted (see
Permissions) — Chrome treats extension-initiated requests as same-site when
the extension holds a host permission for the target. This alone gets the
session cookie accepted by the PAM API: the first import attempt without a
CSRF header returned `HTTP 400 - CSRF validation failed`, not a 401/403,
confirming the cookie was accepted and only the double-submit CSRF token was
missing.

CSRF is required, and `src/csrf.ts` is wired into `extension/background.js`.
The worker reads the token with
`chrome.cookies.getAll({ url: origins.pcloudOrigin })` — the `url` form,
because the token cookie may be scoped to `.cyberark.cloud` rather than the
pcloud host — and selects the `XSRF-TOKEN-<guid>` cookie via
`findXsrfCookie(cookies, targetHost)`. `targetHost` is the **hostname** of
`origins.pcloudOrigin`, not the full origin url. Passing it is what activates
the domain-specificity ranking: a host-scoped token beats a `.cyberark.cloud`
one, and a token scoped to an unrelated tenant is excluded outright. Without
it only the fail-closed-on-multiple-candidates path runs, which is wrong for a
partner signed in to several tenants at once. Ambiguity still fails closed.

Cookie diagnostics log **names only, never values**. The "no usable
XSRF-TOKEN cookie" path logs `xsrfCandidateNames(cookies)` rather than every
cookie name present: it shows what was rejected and avoids printing unrelated
names such as SSO tokens.

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
- The optional-permission flow has not been exercised against a live tenant —
  the end-to-end import was confirmed under the old standing
  `host_permissions`. The gesture propagation is confirmed against Chromium
  source (see Permissions), but the native grant prompt has not been seen in
  situ.
- A granted tenant stays granted until revoked in `chrome://extensions`.
  Nothing in the extension surfaces or revokes grants, by design.
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
  wildcard. The `content_scripts` entry in `extension/manifest.json` matches
  the broad `https://*.cyberark.cloud/*` and `content.js` narrows to the
  marketplace host by regex on its first line, so it no-ops in every other
  iframe. This breadth is harmless — a content-script match is not a host
  permission (see Permissions).

## recon/

`recon/` is a throwaway, MAIN-world diagnostic extension used to discover the
iframe API calls above — tab-level network capture does not see fetch/XHR
originating inside cross-origin iframes; only a content script with
`all_frames: true` does.

Security caveat: `recon/observer.js` logs full request URLs, and the
presigned S3 download URL carries live AWS credentials in its query string.
Unload `recon/` when not actively diagnosing, and redact query-string values
if it's ever reused.
