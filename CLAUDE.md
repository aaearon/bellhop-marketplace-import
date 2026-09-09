# CLAUDE.md

## What this is

Bellhop is a Chrome/Edge MV3 extension spike: it adds an
"Import into Privilege Cloud" button beside the "Download" button on Idira marketplace
product pages. Instead of downloading the artifact zip and hand-uploading
it, the button imports it directly into the same tenant's Privilege Cloud.
Supports both connection components and platforms (see Classification
below). Confirmed working end-to-end against a live tenant
(`acme-poc`), for a single connection-component product, as a super
admin.

"Idira" is Palo Alto Networks' rebrand of CyberArk — the vendor product is
the Idira Identity Security Platform (formerly the CyberArk Identity
Security Platform). Marketplace and Privilege Cloud are services of that one
platform, not separate products; a customer has a single platform tenant,
and its services live on sibling subdomains of that tenant (see Tenant URL
structure below). Product docs live at docs.cyberark.com. The public
marketplace is marketplace.idira.pan.dev.

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

These are not two vendors' products stitched together — they are sibling
subdomains of one platform tenant, one per service (shell, Marketplace,
Privilege Cloud). One SSO session and cookie namespace spans all of them.
That is why this extension can move an artifact from Marketplace to
Privilege Cloud using a session the user already holds, and why the CSRF
token cookie is scoped to the `.cyberark.cloud` parent domain rather than to
any single service host — which is what lets the marketplace frame read it
(see Auth).

## Architecture

```
content script (marketplace iframe)
  -> GET /api/downloads/integrations/<uuid>   (same-origin, cookies)
     ^ at CONFIRMATION-DIALOG OPEN, not on the Import click (see Sequencing)
  -> presigned S3 url, cached for the click
  -> read XSRF-TOKEN-<guid> from document.cookie (not HttpOnly)
  -> chrome.runtime.sendMessage
service worker
  -> destination tenant from sender.origin, never from the message body
  -> derive + validate artifact origin from that url (src/origins.ts)
  -> chrome.permissions.request() for the two derived origins
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
  `sha256` was empty on the payloads this was built against, but was
  **observed populated** (a real 64-hex digest) on 2026-09-09, including on the
  WinSCP connection component checked live that day. Treat it as
  sometimes-present: an integrity check against the fetched bytes before the
  import POST now looks possible and is worth building, but it must degrade to
  importing without verification when the field is absent, or it will fail
  closed on products that still return `""`. Nothing verifies it today.
  `fileName` is still empty in practice. Do not invent a digest that the
  endpoint did not supply.

**No endpoint reports the artifact's size, and there is no permission-free way
to obtain it.** Checked live against `cyberiam-poc` on 2026-09-09, for the
WinSCP connection component (a 9,725,456-byte artifact): `/api/integrations/<uuid>`
(24 fields), `/versions` and `/api/downloads/integrations/<uuid>` all carry no
size, byte-count or content-length field. The obvious fallback also fails:
`Content-Length` is a CORS-safelisted response header and `fetch` exposes
headers before the body, so a size probe that aborts after a few bytes would
work — but the artifact bucket sends no `Access-Control-Allow-Origin`. Verified
by test, not assumed: a `cors`-mode fetch to the presigned url fails while a
`no-cors` fetch returns an opaque response, so the request reaches S3 and the
page's CSP is not the blocker. A content script's isolated world bypasses page
CSP but not CORS, so it cannot read that header either.

The consequence is that **the confirmation dialog cannot warn about size.** The
only way to learn the size is the service worker's fetch, which needs the S3
host permission, which is not held at dialog-open and cannot be requested there
— the origin is unknown until the download url resolves, and that `await`
destroys the transient user activation the prompt needs (see Sequencing). A
static "large packages may be rejected" line would sidestep this but assert a
threshold that is not known and fire on every small import. Deliberately not
built; the failure is reported after the fact instead (see Known limitations).

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

The extension declares **zero API permissions** — `extension/manifest.json`
has no `"permissions"` key at all — and installs with **no host access**.
Every host pattern is declared under `optional_host_permissions`, never
`host_permissions`.

`"permissions": ["cookies"]` used to be declared. It is gone: the CSRF token
cookie is not HttpOnly, so the content script reads it from `document.cookie`
and no extension cookie API is involved anywhere (see Auth).

`optional_host_permissions` is the *declaration* of what may ever be asked
for, not what is held. It lists exactly two patterns, **both** of which are
declarations only:

- `https://*.cyberark.cloud/*` — the only way to declare a per-tenant pcloud
  host, since the tenant name is unknown until runtime.
- `https://*.amazonaws.com/*` — the artifact bucket, whose name is likewise
  unknown until runtime (see Artifact origin below).

What is actually **requested**, and therefore ever granted, is the narrow
two-origin set below. Neither wildcard is ever requested, and the service
worker refuses to request either.

This matters because the extension talks to services of a security platform
tenant. `*.cyberark.cloud` as a standing install-time grant means reach into
every customer tenant a partner is signed in to, forever. Optional
permissions make that grant per-tenant, explicit, and revocable.

`content_scripts.matches` is unaffected and stays broad: a declared content
script runs without any host permission, and its same-origin fetches
(`/api/integrations/...`, `/api/downloads/integrations/...`) and its
`document.cookie` read need none either. Only the service worker's two
cross-origin fetches need host access, and both happen after a user click.

The dialog's Import button requests **exactly two** origins, never a wildcard,
and the content script names **neither** of them (`originsToRequest` in
`extension/background.js`):

1. `https://<t>-pcloud.cyberark.cloud/*` — the tenant's vault host, built by
   the worker from `sender.origin` via `deriveOrigins`. Carries the import
   POST.
2. The artifact origin — derived at runtime by the service worker from the
   presigned download url (see Artifact origin). Carries the artifact fetch.

Deriving both in the worker, from values the worker can verify, is the point:
`sender.origin` is Chrome's report of which frame sent the message, so a
compromised content script on tenant A's page cannot name tenant B, and the
tenant the confirmation dialog showed is necessarily the tenant the POST lands
in. The content script passes only the download url, which the worker
validates and then fetches itself.

`chrome.permissions.contains()` runs first over both, so a repeat import into
an already-granted tenant does not re-prompt. Decline or error fails closed:
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
called (`isAllowedOriginPattern`, `src/origins.ts`): each pattern must either
match `/^https:\/\/[a-z0-9-]+-pcloud\.cyberark\.cloud\/\*$/` (the `*` sits
outside the character class so no host-wildcard pattern matches) or pass the
strict artifact-origin validator below. There is deliberately no rule that any
other `cyberark.cloud` form could satisfy — the bare apex included, now that
nothing needs it. Anything else is refused with `unexpected origin requested`
and `request()` is never reached. This keeps a buggy or compromised caller
from using the extension to solicit either wildcard that
`optional_host_permissions` declares — every tenant at once, or every
AWS-hosted origin at once.

## Artifact origin

The artifact origin is **derived at runtime, never hardcoded**. A
Jenkins-generated internal bucket name such as
`jenkinsmarketplacemaster-prod-content-eu-west-2.s3.eu-west-2.amazonaws.com`
changes without notice: hardcoding it means every installed copy of the
extension breaks silently, fixable only by a store update. The manifest
declares only `https://*.amazonaws.com/*`, and the concrete origin is worked
out per import.

**The service worker derives it itself**, in `originsToRequest`
(`extension/background.js`), from the presigned download url it is about to
fetch — the same url, one source of truth. It deliberately does not accept an
origin passed to it by the content script (nothing does — the pcloud origin
comes from `sender.origin` for the same reason): otherwise a compromised content
script could talk the worker into requesting a grant for an attacker-chosen
host just by asserting "trust this origin". `handleImport` re-runs the same
derivation before fetching, so the origin fetched is the origin that was
granted.

Validation lives in `src/origins.ts` (`s3OriginPatternFromDownloadUrl`,
`isValidS3Origin`, `isS3OriginPattern`), unit-tested in `test/origins.test.ts`.
A requestable artifact origin must be exactly `https://<host>` where `<host>`:

- ends with `.amazonaws.com` and has at least one real label in front — this
  is what rejects `evil-amazonaws.com` and `amazonaws.com.evil.com`;
- is **S3-shaped, virtual-hosted style**: an S3 endpoint label sits where an S3
  endpoint actually sits — the last label before the suffix, or the one before
  a single region label — with at least one **bucket** label in front of it.
  So `bucket.s3.amazonaws.com`, `bucket.s3.<region>.amazonaws.com`, the legacy
  `bucket.s3-<region>.amazonaws.com`, the access-point/object-lambda variants
  and S3 Express One Zone (`…--x-s3.s3express-<az>.<region>.amazonaws.com`)
  all pass. Three things are rejected that a looser rule let through:
  - the suffix check alone accepted *any* AWS-hosted origin, so a manipulated
    download url could have won a grant for `sts.amazonaws.com` or anything
    else on that suffix;
  - an *unanchored* "some label looks like `s3`" check let the bucket name
    carry it: `s3-backups.execute-api.eu-west-1.amazonaws.com` is an API
    Gateway host and passed. Position is now checked;
  - **path-style endpoints** (`s3.amazonaws.com`, `s3.<region>.amazonaws.com`)
    are rejected outright. That host is shared by every bucket in the region,
    so granting it grants all of them. The marketplace's recorded url is
    virtual-hosted, so nothing is given up.

  The endpoint label regex is `^s3(express)?(-[a-z0-9-]+)?$` — anchored at both
  ends, so `s3cret.amazonaws.com` and `bucket.s3x...` do not match. Anything
  outside those three families, and any partition other than the commercial one
  (`amazonaws.com.cn`), is **not** covered and fails closed with a clear error;
  the JSDoc on `S3_ENDPOINT_LABEL_RE` says so explicitly rather than claiming
  full coverage. This is a **validator** rule only: the manifest declaration
  stays the region-agnostic `https://*.amazonaws.com/*`, because pinning a
  region there would re-create exactly the silent breakage the hardcoded bucket
  name caused;
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

Clicking "Import into Privilege Cloud" opens a DOM confirmation dialog (built inline in
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

Because that open is `await`ed rather than instant, the "Import into Privilege Cloud"
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
connection-component product (Oracle SQL Developer for VS Code). The portal
is React/PrimeReact under the hood (`p-button`, `p-component`, `data-pc-*`),
**not** Angular — there is no `_ngcontent-*` anywhere in the observed
markup.

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
(`id="bellhop-btn"` / `data-bellhop-btn`) so a later
MutationObserver pass can't re-anchor onto it. If no strategy matches,
nothing is injected and the console says so clearly (fail closed — see
Known limitations for the residual risk).

The injected button itself is built by cloning the vendor's Download button
(`downloadBtn.cloneNode(true)`) rather than a bare `<button>`, so PrimeReact's
inner `.p-button-label` span structure (and its styling) is preserved; all
label writes (loading/success/failure text) go through the inner span too,
via a `setButtonLabel` helper, falling back to plain `textContent` on the
button — with a console warning at construction time — if that span is ever
missing.

Note for future debugging: the product page's DOM sits inside a doubly-nested
cross-origin iframe (`<t>.cyberark.cloud` → `<t>-managespace.cyberark.cloud`
→ `<t>-marketplace.cyberark.cloud`), which DOM-inspection browser-automation
tools cannot reach into, returning only the shell's accessibility tree;
console log capture does reach across that boundary, since `chrome.runtime`
messages from the content script's own isolated-world execution surface
there regardless of frame origin.

## Auth

The service worker's `fetch` with `credentials: 'include'` carries the tenant
session cookie once the tenant's host permission has been granted (see
Permissions) — Chrome treats extension-initiated requests as same-site when
the extension holds a host permission for the target. This alone gets the
session cookie accepted by the Privilege Cloud API: the first import attempt without a
CSRF header returned `HTTP 400 - CSRF validation failed`, not a 401/403,
confirming the cookie was accepted and only the double-submit CSRF token was
missing.

CSRF is required, and `src/csrf.ts` is wired into `extension/background.js`.

**The token cookie is not HttpOnly, and it is parent-domain scoped.** Both
observed against a live tenant, and the whole design below rests on them.
Shell, marketplace and pcloud are services of one platform tenant sharing a
single SSO session, so `XSRF-TOKEN-<guid>` is set on the shared
`.cyberark.cloud` parent domain — not host-only on
`<t>-pcloud.cyberark.cloud` — and it carries no `HttpOnly` flag. The content
script already running in the marketplace iframe therefore sees it in
`document.cookie`, with no host permission of any kind.

So it reads it there (`readXsrfCookies`, `extension/content.js`) and sends the
XSRF-shaped candidates on the existing `import` message. There is no
`chrome.cookies` call anywhere, the `cookies` permission is not declared, and
the bare `https://cyberark.cloud/*` apex is neither declared nor requested.

The apex used to be in the requested set for exactly one reason:
`chrome.cookies` gates read access on the **cookie's own domain scope**, not
on the url passed to `getAll()`, so for a `.cyberark.cloud` cookie Chrome
checks the extension's permission against `https://cyberark.cloud/`, which a
grant of the exact pcloud origin does not match. That whole problem exists
only if the extension reads the cookie through `chrome.cookies`. It doesn't
any more, so the constraint is gone with it.

If the vendor ever marks the cookie `HttpOnly`, or narrows it to a host-only
cookie on the pcloud host, `document.cookie` in the marketplace frame stops
showing it and the import **fails closed** with the diagnostic below. There is
no fallback path and no retry. Recovering would mean going back to a cookie
permission, or reading the token from a script injected into the vault UI —
both strictly more access than what is here now, and neither is worth
pre-building against a change that may never come.

The worker selects the token with `findXsrfCookie(candidates)` from
`src/csrf.ts`, called **without** a `targetHost`: `document.cookie` exposes no
`domain` field, so there is nothing to rank candidates by, and that is the
exactly-one-candidate-or-`null` branch. More than one candidate can belong to
different tenants, so ambiguity fails closed rather than guessing. The content
script's own filter is a bare `XSRF-TOKEN-` prefix test — deliberately looser
than this, so the two cannot drift in the direction that silently drops a real
token, and so that no unrelated cookie *value* crosses the message boundary.
`findXsrfCookie` remains the authoritative `XSRF-TOKEN-<guid>` match.

`readXsrfCookies` **skips empty values and dedupes on name+value**. An empty
value is not a token but is a truthy candidate, so passing it on would send an
empty `X-XSRF-TOKEN` and turn the clear diagnostic below into an opaque
`HTTP 400 - CSRF validation failed`. The dedupe matters because an SPA can
legitimately shadow the parent-domain SSO cookie with a host-only cookie of the
same name: `document.cookie` then reports the same token twice, exposes no
`domain` field to tell them apart, and `findXsrfCookie` would fail closed
permanently on what is no ambiguity at all. Deduping on name+**value**, not on
name alone, is the point — two genuinely different tokens under one name may
belong to different tenants, and that must still fail closed.

The worker validates the **element shape** of `msg.xsrfCookies`, not just that
it is an array: entries without string `name` and `value` are filtered out, so
a malformed entry cannot throw inside `findXsrfCookie` and surface as a generic
unexpected error instead of the fail-closed CSRF message.

Cookie diagnostics report **counts in the UI and names in the console only,
never values anywhere** — this extension operates inside a live platform
tenant's session. The cookie NAME carries the tenant session guid (the same
reason the `X-<cookie name>` header was dropped), and the failure message is
rendered into the button label on a page the vendor's own SPA occupies, so the
name stays out of it. The "no usable XSRF-TOKEN cookie" failure reports two
counts — how many `XSRF-TOKEN-` candidates the page yielded, and how many of
those were guid-shaped (`xsrfCandidateNames`, `src/csrf.ts`). Those separate
"nothing XSRF-shaped is visible to this frame at all" — the HttpOnly/host-only
case above — from "candidates arrived but none matched the guid shape, or
several did and it failed closed". The label truncates at 120 chars, so the
message stays terse; the candidate names and the target origin go to the
console only. The success path likewise logs the selected cookie's name to the
console only, never the UI, never the value.

**The request header is `X-XSRF-TOKEN`, and only that.** Established by
probing a nonexistent path on the vault API — the CSRF middleware runs ahead
of routing, so this was safe and decisive: no header returned
`400 CSRF validation failed`; `X-XSRF-TOKEN` alone returned `404`, i.e. CSRF
passed and only the route was missing; `X-<cookie name>` alone returned `400`.
The code used to send both, which was harmless but pointless, and the second
header leaked the session guid in a header name. It sends one now.

## Known limitations

- **A 401 from `/api/downloads/integrations/<uuid>` means the SSO session has
  gone stale, not that the extension is broken.** The marketplace SPA keeps
  rendering from state it already holds, so the page looks fine while the one
  call that needs a live session fails. It surfaces as `Cannot import:
  download request failed with status 401` in the confirmation dialog, with
  the Import button disabled — the fail-closed path working as designed, since
  the dialog never offers an import it knows cannot succeed. A hard refresh of
  the tenant tab clears it. Observed 2026-09-09 and confirmed fixed by
  re-authenticating. Diagnostic that separates this from a real bug: click the
  vendor's own Download button. If that also fails, it is the session; if it
  succeeds while ours does not, the two requests differ and that is a bug.
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
  grant all worked. The end-to-end import itself is confirmed only under the
  old standing `host_permissions` and the old `chrome.cookies` CSRF path. The
  current shape — two requested origins, the token read from `document.cookie`,
  the destination derived from `sender.origin`, a single `X-XSRF-TOKEN` header
  — has not been re-run end-to-end against a live tenant. Nothing about it is
  covered by the unit tests, which only reach the pure functions in `src/`.
- A granted tenant stays granted until revoked in `chrome://extensions`.
  Nothing in the extension surfaces or revokes grants, by design.
- **Privilege Cloud's own server-side request-size cap is the binding
  constraint, and it bites far sooner than the service-worker memory/CPU
  limits below.** Measured: a 9,725,456-byte (9.27 MiB) artifact base64's
  into a ~12,967,293-byte (~13 MB) JSON body, and the import POST returned
  `HTTP 500 {"_message":"Maximum request length exceeded.","_exceptionType":"System.Web.HttpException"}`.
  This is ASP.NET's `httpRuntime maxRequestLength`. **The exact configured
  value for the Privilege Cloud SaaS backend is not confirmed — do not
  assume it.** What's publicly known is CyberArk's on-prem PVWA shipping
  `maxRequestLength="10000"` (10,000 KB ≈ 10 MB) per public KB 00000752;
  Privilege Cloud is a different (SaaS) deployment of related software and
  may or may not share that exact figure. Treating 10 MB / "~7.3 MiB of raw
  zip after base64's ~33% overhead" as a *plausible ballpark inferred from
  PVWA*, not a confirmed Privilege Cloud number, is the correct level of
  confidence — the only two hard data points are that 308 KB succeeds and
  9.27 MiB fails. **Confirmed the vendor's own Privilege Cloud import UI
  fails on the same file the same way** — this is a Privilege Cloud
  limitation, not a defect in this extension, and there is no workaround:
  base64-in-JSON is the only encoding either endpoint accepts (confirmed in
  CyberArk's API docs and the psPAS PowerShell module). Deliberate design
  decision: **no client-side pre-flight size gate was added.** The true
  threshold is unconfirmed, and hardcoding a guessed limit — including the
  ~7.3 MiB inference above — would fail closed on artifacts that currently
  work. The POST is still attempted every time regardless of size;
  `src/import-error.ts` (`describeImportFailure`, wired into `handleImport`
  in `extension/background.js`) only makes the resulting error legible — it
  detects this specific ASP.NET exception shape and renders a short "too
  large for Privilege Cloud … not an extension limit" button label instead
  of the raw exception JSON (deliberately without asserting a specific
  threshold, for the same reason), falling through to the existing generic
  `HTTP <status> - <body>` form for every other error shape. Separately:
  CyberArk's docs state `Platforms/Import` accepts artifacts up to 20 MB,
  which cannot fit through a 10,000 KB `maxRequestLength` once base64'd
  (20 MB raw → ~26.6 MB encoded) *if* Privilege Cloud does share PVWA's
  configured value — another reason not to treat that figure as confirmed
  rather than inferred; not otherwise investigated.
- Below that request-size cap, the service worker has a ~30s idle lifetime
  and a 30s cap on any single `fetch()`; the one artifact tested was 308 KB.
  **Encode CPU is not the binding constraint** — measured,
  `arrayBufferToBase64` costs ~45-50 ms/MB, so encoding alone would not
  approach 30s until several hundred MB. Memory is: peak heap is roughly
  3.8x the artifact size, because the ArrayBuffer, the latin1 binary string,
  the base64 string and the JSON request body are all live at once (~470 MB
  for a 128 MB artifact). The S3 download is subject to the same 30s
  single-fetch cap. These limits are likely moot in practice below the
  (unconfirmed) request-size cap above, since that cap probably rejects
  anything larger first; they would only
  matter if Privilege Cloud's own limit were ever raised.
- Product type is inferred, not declared (see Classification). This is a
  heuristic derived from two observed payloads and may misclassify a shape
  not yet seen.
- This is an unsupported integration against a vendor UI. If the vendor
  ships a native "Install to this tenant" action, this becomes redundant.

## Browser support

Chrome and Edge are the supported targets. Firefox is shelved — not ruled
out permanently, just not being worked on now — on one hard blocker.

**Edge — drop-in, no code changes.** Edge Add-ons runs the unmodified
Chromium extensions implementation, so `chrome.permissions.request()`/
`.contains()`, `optional_host_permissions`, MV3 service-worker backgrounds,
and — critically — the transient-user-activation propagation across
`runtime.sendMessage` documented from Chromium source under Permissions all
apply identically: that mechanism is Chromium engine code, not a
Chrome-branded layer. MV3 is Edge's baseline going forward. The only
observed difference is cosmetic — Edge's first-install permission-listing
UI for `optional_host_permissions` renders differently from Chrome's. Same
manifest, same package; the remaining work is a store listing, not
porting.

**Firefox — shelved, one hard blocker.** Firefox does not propagate user
activation across `runtime.sendMessage` into a background `onMessage`
handler. MDN states `permissions.request()` may only be called inside a
user-action handler; Bugzilla 1392624 (still OPEN, comment ~2023: "this is
far from FIXED") tracks precisely the inability to transfer user-input
context through `runtime.sendMessage` from a content script; Bugzilla
1397658 is a RESOLVED DUPLICATE of it. The observed runtime error is
`permissions.request may only be called from a user input handler`. This
makes the extension's whole click chain throw on Firefox regardless of how
carefully the synchronous-dispatch discipline documented under Permissions
is preserved — that discipline is necessary but not sufficient there.
Working around it requires the grant-triggering click to happen inside an
extension-owned surface (popup or extension tab) rather than being relayed
from a page content script, which is a UX redesign for one browser and
conflicts with the dialog-open sequencing that exists for the presigned
URL's 600s TTL (see Sequencing under Artifact origin). Estimated at
low-to-mid single-digit days. Shelved on that basis, not because it's
impossible.

Three smaller Firefox findings, recorded so they aren't re-researched if
Firefox is revisited:

- `background.service_worker` is unsupported on Firefox (Bugzilla
  1573659); it needs `background.scripts` with `"type": "module"` (Firefox
  112+). One manifest can serve all three browsers. ~1 hour of work.
- Cookie *reading* is no longer a Firefox concern at all: the token comes from
  `document.cookie` in the content script, which behaves identically
  everywhere. This obsoletes the earlier finding about Firefox's more
  permissive `cookies` permission model, and the container-tab risk around
  `cookies.getAll()` and its missing `storeId`.
- Container tabs remain a Firefox-only risk on the *write* side, and it lands
  on this extension's actual users — partners signed into multiple tenants at
  once is the textbook Multi-Account Containers case. Bugzilla 1670278 (open)
  indicates a background `fetch` with `credentials: 'include'` may not be
  scoped to a container's cookie jar at all, meaning the import POST could
  silently use the wrong identity rather than failing closed. Needs live
  testing; may not be cleanly fixable.

A `webextension-polyfill` dependency is not warranted for any of this — a
3-line `var api = typeof browser !== "undefined" ? browser : chrome;` shim
covers it and preserves the no-bundler convention.

## Future direction

The Idira Marketplace carries integrations for all of the platform's
services, not just Privilege Cloud, so this extension may later target
other services of the platform. The design already accommodates that
additively: `classifyProduct`/
`importPathFor` (`src/classify.ts`) map an `idiraServices` marker to a
destination, and `deriveOrigins` already derives per-service hosts from the
tenant name, so adding a service would mean a new mapping plus a host, not a
rewrite. Current scope remains exactly PSM connection components and
CPM/SRS platforms, both on Privilege Cloud.

## Icons

`extension/icons/` holds the "Bellhop" mascot icon set: the full character
(cap, torso, arms, parcel-in-hand) at 128px and 48px, and a reduced parcel
mark (just the box) at 32px and 16px. This split is intentional, not
inconsistency — the character silhouette doesn't survive below 48px, while
the parcel stays legible and unambiguous at toolbar sizes where the
character would reduce to a cap-shaped blob. `tools/make-icons.py`
regenerates the entire set (icon16/32/48/128.png + preview.png) standalone
from inline SVG source via ImageMagick `convert` + Pillow; run
`python3 tools/make-icons.py` after any artwork change.

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
  `csrf.ts` before this was fixed. The same gitignored-but-imported
  relationship means packaging must run `npm run build` immediately
  before zipping: a naive zip from a fresh clone ships an
  `extension/lib/` that doesn't exist, and it fails at runtime with no
  compile-time error — the identical failure mode.
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
- Packaging and version sync: `npm run package` builds and zips `extension/`
  into `dist/` for store submission; `npm run check:version` verifies
  `extension/manifest.json` and `package.json` report the same version
  before packaging. Neither script's output (`dist/`) is committed.
- Releases: pushing a `v*` tag runs `.github/workflows/release.yml`, which
  additionally requires the tag to agree with `manifest.json`/`package.json`
  (`npm run check:tag`, backed by `checkTagVersionSync` in `src/version.ts`)
  before publishing a GitHub Release with `dist/bellhop-<version>.zip`
  attached. Zip only — no CRX signing, no manifest `key`. The release is
  zip-only and store-upload/load-unpacked only; it is not drag-and-drop
  installable.
- `docs/` is published as a public GitHub Pages site (project site, built
  from the `docs/` folder by GitHub's built-in Jekyll, no workflow file) —
  this is how `docs/PRIVACY.md` satisfies the Chrome Web Store's and Edge
  Add-ons' requirement for a privacy policy at a public URL, not just a
  repo file. Any Markdown file under `docs/` meant to render as its own
  page needs a YAML front matter block (even a minimal one) — Jekyll only
  processes files that have one; without it, the file is copied through
  unprocessed rather than rendered as HTML. `docs/PRIVACY.md` and
  `docs/STORE-PERMISSIONS.md` pin their public paths with an explicit
  `permalink:` (`/privacy/`, `/store-permissions/`) so the URLs stay stable
  across renames; `docs/index.md` is the Pages root and links both.

## How the marketplace API was found

The API calls documented above (see Marketplace API) were found using a
throwaway, MAIN-world diagnostic browser extension, since removed from this
repository. It was needed because tab-level network capture does not see
fetch/XHR calls originating inside a cross-origin iframe; only a content
script with `all_frames: true` does. It redacted request URLs before
logging — query-string values, including the presigned S3 download link's
embedded AWS credentials, were replaced with a length-only placeholder,
never logged in the clear.

Cookie and URL logging in the shipped extension follows the same policy:
presigned/credentialed URLs are redacted before they ever reach a log, and
cookie diagnostics report names only, never values (see Auth).
