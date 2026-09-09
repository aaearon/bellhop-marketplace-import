# CLAUDE.md

## What this is

Idira Integration Importer is a Chrome MV3 extension spike: it adds an
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
     ^ at CONFIRMATION-DIALOG OPEN, not on the Import click (see Sequencing)
  -> presigned S3 url, cached for the click
  -> chrome.runtime.sendMessage
service worker
  -> derive + validate artifact origin from that url (src/origins.ts)
  -> chrome.permissions.request() for the derived origin
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
  presigned AWS S3 link (600s TTL) on an origin outside `cyberark.cloud`. That
  origin is not stable and is never hardcoded — see Artifact origin, which also
  covers why this endpoint is called at dialog-open.
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
`extension/manifest.json` declares every host pattern under
`optional_host_permissions`, never `host_permissions`. `"permissions":
["cookies"]` stays declared but is inert on its own: `chrome.cookies` can
only reach hosts the extension currently holds a host permission for, so
narrowing host permissions transitively narrows cookie reach.

`optional_host_permissions` is the *declaration* of what may ever be asked
for, not what is held. It lists exactly three patterns, **all** of which are
declarations only:

- `https://*.cyberark.cloud/*` — the only way to declare a per-tenant pcloud
  host, since the tenant name is unknown until runtime.
- `https://cyberark.cloud/*` — the apex.
- `https://*.amazonaws.com/*` — the artifact bucket, whose name is likewise
  unknown until runtime (see Artifact origin below).

What is actually **requested**, and therefore ever granted, is the narrow
three-origin set below. Neither wildcard is ever requested, and the service
worker refuses to request either.

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

The dialog's Import button requests **exactly three** origins, never a
wildcard (`requiredOriginPatterns` in `extension/content.js`):

1. `https://<t>-pcloud.cyberark.cloud/*` — the tenant's vault host, built from
   the `pcloudOrigin` the classify response already returns. Carries the import
   POST.
2. `https://cyberark.cloud/*` — the bare apex, no subdomain wildcard. Required
   only to read the CSRF cookie, which is parent-domain scoped (see Auth). It
   confers nothing on any tenant subdomain: `cyberark.cloud` itself hosts no
   tenant.
3. The artifact origin — derived at runtime by the service worker from the
   presigned download url (see Artifact origin). Carries the artifact fetch.

`chrome.permissions.contains()` runs first over all three, so a repeat import
into an already-granted tenant does not re-prompt. Decline or error fails closed:
the button reads `Failed: permission not granted` and nothing else is tried.

`chrome.permissions` is a `privileged_extension`-context API (Chromium
`extensions/common/api/_api_features.json`), so it is **undefined in a content
script**. Both calls therefore happen in the service worker, reached by
`chrome.runtime.sendMessage`, and no extension page is involved:

- `permissionsContains` — no user gesture required, so it is asked early, when
  the confirmation dialog opens (`openConfirmDialog`), right after the download
  url resolves; its answer is cached on the dialog's `plan` as
  `alreadyGranted`. It cannot be asked any earlier than that, because the
  artifact origin is not known until the download url exists, and the set
  checked must be exactly the set that would be requested.
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
  work moved to `runImport`, called afterwards. Resolving the download url and
  `contains()` at dialog-open is what makes this possible — see Artifact origin.
- `background.js` handles `permissionsRequest` as the **first** branch of the
  listener, validates synchronously, and calls `request()` in its callback
  form. No `await` precedes it. Origin *derivation* (`originsToRequest`) is
  synchronous for the same reason — it is pure string/URL work, no I/O.

The requested origins are validated in the service worker before `request()` is
called (`isAllowedOriginPattern`, `src/origins.ts`): each pattern must be
exactly the literal `https://cyberark.cloud/*`, match
`/^https:\/\/[a-z0-9-]+-pcloud\.cyberark\.cloud\/\*$/` (the `*` sits outside
the character class so no host-wildcard pattern matches), or pass the strict
artifact-origin validator below. The apex is an exact string comparison, not a
pattern — there is deliberately no rule that any `*.cyberark.cloud` form could
satisfy. Anything else is refused with `unexpected origin requested` and
`request()` is never reached. This keeps a buggy or compromised caller from
using the extension to solicit either wildcard that
`optional_host_permissions` declares — every tenant at once, or every
AWS-hosted origin at once.

## Artifact origin

The artifact origin is **derived at runtime, never hardcoded**. It used to be
the literal bucket
`jenkinsmarketplacemaster-prod-content-eu-west-2.s3.eu-west-2.amazonaws.com`,
pinned in both `optional_host_permissions` and the worker's allowlist. That is
a Jenkins-generated internal bucket name and it changes without notice: when it
changed, every installed copy of the extension broke silently, and the only fix
was shipping a store update. The manifest now declares only
`https://*.amazonaws.com/*`, and the concrete origin is worked out per import.

**The service worker derives it itself**, in `originsToRequest`
(`extension/background.js`), from the presigned download url it is about to
fetch — the same url, one source of truth. It deliberately does not accept an
origin passed to it by the content script: otherwise a compromised content
script could talk the worker into requesting a grant for an attacker-chosen
host just by asserting "trust this origin". `handleImport` re-runs the same
derivation before fetching, so the origin fetched is the origin that was
granted.

Validation lives in `src/origins.ts` (`s3OriginPatternFromDownloadUrl`,
`isValidS3Origin`, `isS3OriginPattern`), unit-tested in `test/origins.test.ts`.
A requestable artifact origin must be exactly `https://<host>` where `<host>`:

- ends with `.amazonaws.com` and has at least one real label in front — this
  is what rejects `evil-amazonaws.com` and `amazonaws.com.evil.com`;
- matches a concrete-hostname regex, which is what rejects the wildcard
  `https://*.amazonaws.com` itself. **This matters:** `*` is not a forbidden
  host code point, so `new URL()` alone keeps it in `hostname` and the
  `endsWith` check would pass. The wildcard is a manifest declaration and must
  never be a requested origin;
- carries no embedded userinfo (`user:pass@host`) and no explicit port;
- is scheme `https:` exactly, with no path, query or fragment.

Anything else returns null and the import **fails closed** with a clear error;
there is no fallback host and no retry.

### Sequencing: when the download url is fetched

`GET /api/downloads/integrations/<uuid>` runs when the **confirmation dialog
opens** (`openConfirmDialog` in `extension/content.js`), and nowhere else. Both
neighbouring placements are wrong:

- **Not at button-injection time.** The url is presigned with a 600s TTL. A
  user who leaves the product page open and idle would reach the dialog holding
  an expired link.
- **Not in the Import click handler.** `chrome.permissions.request()` needs
  transient user activation, which decays within a few seconds of the click,
  and this is a network round trip. Awaiting it inside the click would blow the
  activation window and the native prompt would be refused.

Dialog-open is the only point that satisfies both: maximally fresh, and
`await`ed to completion before the Import button can possibly be clicked. The
url is cached on the dialog's `plan` object and reused verbatim by the
permission request, the import message and the worker's fetch.

If that fetch fails, the dialog **still opens** — but with a `Cannot import:
<reason>` line and its Import button disabled. A dialog that is doomed to fail
is never offered as if it would work, and there is no silent fallback.

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

Opening the dialog is also where the presigned download url is resolved and
where `permissions.contains()` is asked, both `await`ed before the dialog
renders — see Sequencing under Artifact origin for why that point and not
another, and for the disabled/error state when the url cannot be resolved.

Because that open is `await`ed rather than instant, the "Import to tenant"
button shows its own loading state (disabled, small inline CSS spinner,
"Preparing…") for exactly that gap, cleared as soon as `openConfirmDialog`
returns — on every path, including a failed pre-dialog fetch or a thrown
error.

## Injection anchor

The Import button is inserted `afterend` of the vendor's Download button, so
finding that button reliably is load-bearing: miss it and the extension
silently offers nothing. `findAnchorButton` in `extension/content.js` tries
four strategies in order, most durable first, and logs which one matched (or
that none did) so a future break is diagnosable from the console rather than
by bisecting.

Observed live against `acme-poc`, product-info page for a
connection-component product (Oracle SQL Developer for VS Code), by
temporarily instrumenting the content script itself to dump the Download
button and its ancestors to the console — the outer browser-automation
tooling used to drive this investigation could not see into the marketplace
iframe at all (see below). The portal is React/PrimeReact under the hood
(`p-button`, `p-component`, `data-pc-*`), **not** Angular — there is no
`_ngcontent-*` anywhere in the observed markup, contrary to an earlier
assumption. Observed markup:

```html
<div class="item-header__row">
  <div class="item-header__identity">…logo, title, "By: Idira"…</div>
  <button aria-label="Download" class="p-button p-component p-button-lg"
          type="button" data-testid="item-download"
          data-pc-name="button" data-pc-section="root">
    <span class="p-button-icon p-c p-button-icon-left cyb-icon-size-sm cyb-icon-download-04"
          data-pc-section="icon"></span>
    <span class="p-button-label p-c" data-pc-section="label">Download</span>
  </button>
</div>
```

1. **`[data-testid="item-download"]`** — OBSERVED. The most durable signal
   found: a vendor test id, generally stable across localisation/copy
   changes (though not immune to a vendor refactor).
2. **Icon class `cyb-icon-download-*`** — OBSERVED (`cyb-icon-download-04`
   exactly; the wildcard suffix match is a hedge, not confirmed). Part of the
   portal's own icon-font convention; language-independent.
3. **Structural: last non-own `button`/`a` inside `.item-header__row`** —
   OBSERVED on this one product only. `item-header__row` is an authored,
   semantic class (not a build hash) holding the identity block and the
   Download button as siblings; GUESS that the same structure holds for
   platform-kind products, which were not checked live.
4. **Text match, last resort** — case-insensitive match of trimmed
   `textContent` or `aria-label` against `"download"`. The only strategy
   that breaks under localisation or a vendor copy change; kept only as a
   safety net, not enumerated per-language.

Every strategy excludes the extension's own injected button
(`id="import-to-tenant-btn"` / `data-import-to-tenant-btn`) so a later
MutationObserver pass can't re-anchor onto it. If no strategy matches,
nothing is injected and the console says so clearly (fail closed — see
Known limitations for the residual risk).

**Tooling note:** the `read_page`/`find` browser-automation tools could not
reach into the product page's DOM at all in this session — it sits inside a
doubly-nested cross-origin iframe
(`<t>.cyberark.cloud` → `<t>-managespace.cyberark.cloud` →
`<t>-marketplace.cyberark.cloud`) and those tools returned only the shell's
own accessibility tree no matter the wait time, tab, or query. Console log
capture (`read_console_messages`) does reach across that boundary, since
`chrome.runtime` messages from the content script's own isolated-world
execution surface there regardless of frame origin. The DOM dump above was
obtained by temporarily adding diagnostic `console.log` calls to
`extension/content.js` itself (reloading the unpacked extension to pick them
up) rather than by external inspection — that diagnostic code has been
removed from the shipped file.

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

**The token cookie is parent-domain scoped.** `XSRF-TOKEN-<guid>` is an SSO
cookie set on `.cyberark.cloud` and shared across the shell, marketplace and
pcloud hosts — not a host-only cookie on `<t>-pcloud.cyberark.cloud`.
`chrome.cookies` gates read access on the **cookie's own domain scope**, not
on the url passed to `getAll()`: for a `.cyberark.cloud` cookie Chrome checks
the extension's permission against `https://cyberark.cloud/`, which a grant of
the exact pcloud origin does not match. Granting only the pcloud origin
therefore returns zero candidates and the import fails at the CSRF step, even
though the browser itself happily sends that cookie to the pcloud host. This
is why `https://cyberark.cloud/*` is in the requested origin set (see
Permissions). It is not a fallback and there is no alternative: reading the
token from a content script injected into the vault UI was rejected as a worse
trade-off than a scoped cookie permission.

The worker reads the token with
`chrome.cookies.getAll({ url: origins.pcloudOrigin })` — the `url` form, so it
gets exactly the cookies that would be sent to the pcloud origin, parent-domain
ones included — and selects the `XSRF-TOKEN-<guid>` cookie via
`findXsrfCookie(cookies, targetHost)`. `targetHost` is the **hostname** of
`origins.pcloudOrigin`, not the full origin url. Passing it is what activates
the domain-specificity ranking: a host-scoped token beats a `.cyberark.cloud`
one, and a token scoped to an unrelated tenant is excluded outright. Without
it only the fail-closed-on-multiple-candidates path runs, which is wrong for a
partner signed in to several tenants at once. Ambiguity still fails closed.

Cookie diagnostics report **names and domains only, never values** — this sits
next to a PAM product, so a cookie value must never reach a log or the UI. The
"no usable XSRF-TOKEN cookie" failure reports the cookie count `getAll`
returned, the distinct cookie domains seen (`cookieDomains`, `src/csrf.ts`)
and the XSRF-shaped candidate names (`xsrfCandidateNames` — candidate names
only, so unrelated cookie names such as SSO tokens are never printed). Those
three together separate "not readable at this permission scope" (no cookies,
or no `.cyberark.cloud` domain among them) from "readable but nothing
matched". The message is surfaced in the button label, which truncates at 120
chars, so it stays terse and the target origin goes to the console only. The
success path logs the selected cookie's name and domain to the console only,
never the UI, to keep the scoping above grounded in observation.

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
- Re-importing an already-imported connection component returns **HTTP 409**
  with a long `{"ErrorCode":"CAWS00001E","ErrorMessage":...}` body. The button
  label truncates at 120 chars, which turned that into mid-sentence nonsense,
  so 409 — and only 409 — is rendered as `Failed: Already imported into this
  tenant`. It is still a failure, not a success; the raw status and body go to
  the console (content script and service worker). Every other status keeps
  the `HTTP <status> - <body>` form. Deliberately not a status→message table:
  one observed status, one special case.
- Re-import behaviour for platforms is untested.
- A 200 from the import endpoint has not been confirmed to mean the
  component actually functions afterward — only that the POST succeeded.
- The injection anchor (`findAnchorButton` in `extension/content.js`) tries
  several strategies before falling back to a text match — see "Injection
  anchor" below. The remaining risk is a vendor rename of the `item-download`
  test id and the `cyb-icon-download-*` glyph class in the same redeploy,
  which would drop through to the text-match fallback (English-only, still
  breakable by localisation).
- The optional-permission flow has been exercised against a live tenant up to
  the grant: the confirmation dialog, the gesture-driven native prompt and the
  grant all worked. The import then failed on the parent-domain cookie scope
  (see Auth); the three-origin set that fixes it has not yet been re-run
  end-to-end against a live tenant. The end-to-end import itself is confirmed
  only under the old standing `host_permissions`.
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
  (`base64.ts`, `csrf.ts`, `tenant.ts`, `classify.ts`, `origins.ts`) are
  unit-tested. Test
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
