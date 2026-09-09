---
layout: default
title: Store Permission Justifications
permalink: /store-permissions/
---

# Chrome Web Store Submission — Bellhop

> Distribution is confirmed for both the Chrome Web Store and Microsoft Edge Add-ons. This
> document is written for the Chrome Web Store Developer Dashboard's fields, but the same
> per-permission justifications answer Edge's equivalent certification questions (Edge developer
> policy §1.5 Personal information, §1.6 Permissions) — paste from here into Edge's Partner Center
> notes as well.

Draft text for the Web Store Developer Dashboard's "Privacy practices" and "Permissions
justification" fields. Each section below maps to one form field. Verified against
`extension/manifest.json`, `extension/content.js`, `extension/background.js`, `src/*.ts`.

---

## Single purpose description

> Bellhop carries integrations from the Idira Marketplace into Privilege Cloud, so you
> do not have to download a package and upload it again by hand. It currently
> supports Privilege Cloud connection components and platforms, and it never opens
> the package: the bytes are passed through unmodified so the signature stays valid.
>
> Not affiliated with or endorsed by Palo Alto Networks or CyberArk.

---

## Permission justifications

### API permissions

**None.** `extension/manifest.json` has no `"permissions"` key at all. The extension declares zero
API permissions and requests none at runtime.

This includes `cookies`, which an earlier version did declare. The tenant's double-submit CSRF
cookie, `XSRF-TOKEN-<id>`, is not marked `HttpOnly` and is scoped to the shared `.cyberark.cloud`
parent domain, so the content script already running in the marketplace page reads it from
`document.cookie` — the same way the marketplace's own page JavaScript can. That needs no
extension permission of any kind, so the `cookies` permission was removed rather than kept for
convenience. Echoing that token back as the `X-XSRF-TOKEN` header is required: the tenant's
Privilege Cloud import API rejects requests without it (confirmed — an import attempt without a
CSRF header returns `HTTP 400 - CSRF validation failed`, not an auth error, i.e. the session
cookie itself was already accepted).

**What is read, and what is not:** `document.cookie` returns the cookies for the page's own
origin. The content script splits that string and keeps only entries whose *name* begins
`XSRF-TOKEN-`; every other cookie's value is discarded on the spot and never leaves the content
script. Only the matched candidates are passed to the service worker, which selects the one
matching `XSRF-TOKEN-<guid>` (`findXsrfCookie`, `src/csrf.ts`) and fails closed if none matches or
if more than one does. Diagnostic logging, used only on failure, reports how many candidates were
found and their *names* (`xsrfCandidateNames`). No cookie value is ever logged, anywhere, for any
cookie. No cookie is ever written.

### Host permissions

**These two patterns are declarations of what may ever be asked for. They are never requested and
never held.** `extension/manifest.json` lists every host pattern the extension may ever ask for
under `optional_host_permissions` — never under `host_permissions`. On installation the extension
holds **zero** host access, and at no point does it hold either pattern below as a standing grant.
A reviewer who sees the literal string `https://*.amazonaws.com/*` in the manifest is looking at
the ceiling on what can be asked for, not at what is requested or granted:

- `https://*.cyberark.cloud/*`
- `https://*.amazonaws.com/*`

**What is actually requested, at runtime, on the user's Import click** is never one of those
wildcards. It is exactly two specific origins, computed per import and checked against an
allowlist before `chrome.permissions.request()` is ever called. That allowlist — the enforcement
point that keeps a wildcard from ever reaching `request()` — is a single function,
`isAllowedOriginPattern` in `src/origins.ts`, and it is unit-tested in `test/origins.test.ts`:

1. **The one tenant's Privilege Cloud host** — `https://<tenant>-pcloud.cyberark.cloud/*` — to
   POST the artifact to the tenant the user is currently viewing and confirmed in the dialog. The
   service worker derives this from the origin of the frame that sent it the message, as Chrome
   reports it, so the destination cannot be anything other than the tenant the user is on and the
   dialog named.
2. **The specific artifact host** — derived at runtime from the presigned download URL the
   marketplace itself issues (an AWS-hosted content origin whose exact hostname is not fixed and
   is never hardcoded), so the artifact bytes can be fetched. This origin is derived by the
   extension from a URL the user's own marketplace session returned, not supplied by any other
   party. It is additionally required to be an S3 endpoint host, so a manipulated download URL
   cannot win a grant for some other AWS-hosted service. Path-style S3 endpoints
   (`s3.amazonaws.com`, `s3.<region>.amazonaws.com`) are rejected outright even though they are
   real S3 hosts: that hostname is shared by every bucket in the region, so granting it would
   grant access to all of them, not just the one artifact bucket. Only virtual-hosted-style
   origins (`<bucket>.s3.<region>.amazonaws.com` and its access-point/S3-Express variants) pass.

**Why no narrower static pattern is possible:** Neither wildcard can be replaced by a fixed
hostname in the manifest, for two independent reasons:

- The tenant hostname and the S3 bucket hostname are both **unknown until runtime**. The tenant is
  whatever tenant the user happens to be signed into when they click Import; the artifact bucket
  name is a vendor-internal, Jenkins-generated string that has already changed once without
  notice. There is no fixed value either pattern could name instead.
- Even if the tenant name were knowable ahead of time, **Chrome match patterns cannot express a
  partial subdomain wildcard.** A pattern like `https://*-pcloud.cyberark.cloud/*` — wildcarding
  only the tenant-name segment of the host while fixing the rest — is rejected by Chrome outright
  as an invalid host wildcard; the same restriction is why `content_scripts.matches` (see below)
  is broad for the identical reason. `https://*.cyberark.cloud/*` and `https://*.amazonaws.com/*`
  are the narrowest forms Chrome's manifest syntax allows that still cover a per-tenant or
  per-bucket host at all.

Given that, the declaration is pinned at the widest scope Chrome's model allows the extension to
*ask about*, and the actual request is narrowed in code, at runtime, to one concrete host per
import — narrower than the manifest can express, validated by `isAllowedOriginPattern`, and never
widened back out to either declared wildcard.

**What it is not used for:** No standing grant is ever created. A user who has approved tenant A
has no access granted to tenant B; each tenant requires its own explicit approval, shown as a
native Chrome permission prompt naming the exact origin. Nothing is granted silently, and nothing
is granted for a tenant the user has not clicked Import against. The extension does hold the
narrow, per-tenant and per-artifact-host grants a user has actually approved, for as long as the
user leaves them in place — access is minimized and revocable, not absent; see "Site access" in
`chrome://extensions` to review or remove a grant.

### `content_scripts` — match pattern `https://*.cyberark.cloud/*` and `all_frames: true`

**What it enables:** Running the content script — unconditionally, at install time, no permission
prompt — on every page under `*.cyberark.cloud`, in every frame on that page, not just the
top-level document.

**Why the match pattern is the whole apex, not just the marketplace subdomain:** Chrome match
patterns cannot express a partial subdomain wildcard — `https://*-marketplace.cyberark.cloud/*` is
rejected outright as an invalid host wildcard. `https://*.cyberark.cloud/*` is the narrowest
pattern Chrome's manifest syntax allows that still covers the marketplace subdomain, whatever a
given tenant's name is. The script narrows itself in code, in its own first line: it checks
`location.hostname` against a regex for the `<tenant>-marketplace.cyberark.cloud` shape and
returns immediately, doing nothing at all, everywhere else — including the shell, the PasswordVault
UI, and any other `*.cyberark.cloud` subdomain. A content script match is not a host permission by
itself and grants no cross-origin `fetch` access and no extension-level cookie access; the
same-origin fetches this script performs (`/api/integrations/...`,
`/api/downloads/integrations/...`) and its `document.cookie` read run only on the one frame that
passes that check, using the page's own existing session, with exactly the reach the page itself
already has.

**Why there is no lesser alternative for `all_frames`:** The Idira marketplace product page the
button is injected into is not the top-level document — the tenant UI is a shell page that loads
the marketplace as a nested, cross-origin iframe (and that iframe itself refuses to render as a
top-level page). Only `all_frames: true` reaches it.

**What it is not used for:** Outside the one marketplace frame that passes the hostname check, the
script is present in memory but never runs any of its logic — it does not read or act on content
in the shell, PasswordVault, or any other frame or page it happens to load into.

---

## Remote code

**None.** All code the extension executes ships inside the installed package
(`extension/content.js`, `extension/background.js`, and the compiled `extension/lib/*.js`
modules). There is no `eval`, no `new Function`, no remotely fetched or injected script, and no
external runtime dependency loaded at execution time. This is verifiable directly: every file the
extension loads is listed in `extension/manifest.json` and shipped in the package; a reviewer can
confirm by reading those files that no network response is ever passed to a code-execution
primitive — the only external bytes the extension fetches (the artifact zip) are base64-encoded
and forwarded as opaque data, never parsed or executed.

---

## Data usage disclosures

| Category | Collected? | Detail |
|---|---|---|
| Personally identifiable information | No | — |
| Health information | No | — |
| Financial and payment information | No | — |
| Authentication information | **Read, not collected** | The extension reads one CSRF cookie value from `document.cookie` on the marketplace page and echoes it, in-request, as the `X-XSRF-TOKEN` header on a request to the same tenant it came from. The value is never transmitted to any other destination, never written to storage or disk, and never logged — logs record only that cookie's name on success, or (on failure to find it) the names of any XSRF-shaped candidates, still no value, ever, for any cookie. Never retained after the request completes. It is not "collected" in the sense of being gathered, stored, or reused — it is read once per import and used once, immediately, for the single request that needs it. |
| Personal communications | No | — |
| Location | No | — |
| Web history | No | — |
| User activity (clicks, keystrokes, etc.) | No | The extension listens only for a click on its own injected Import button and buttons within its own confirmation dialog. It does not monitor browsing, other page interactions, or activity outside its own UI. |
| Website content | Limited, same-origin only | Reads the marketplace product page's own API responses (`/api/integrations/...`, `/api/downloads/integrations/...`) via the page's existing session, to display product details and obtain the artifact. Reads no other page content. |

**Overall:** This extension does not collect, store, or transmit any user data to the developer
or to any third party. Data described above moves only between the user's browser, the user's own
tenant, and the vendor's own content host — destinations the user already has a direct
relationship with — and none of it is retained by the extension after each import completes.

No data is sold. No data is used for advertising or for any purpose unrelated to the extension's
single stated purpose.

---

## Note for the reviewer

This extension does not bridge two vendors' products, and it does not cross a trust boundary. The
vendor product is the single Idira Identity Security Platform (formerly the CyberArk Identity
Security Platform); Marketplace and Privilege Cloud are services of that one platform, not
separate products. A customer has one platform tenant, and its services live on sibling
subdomains of that tenant (the shell at `<tenant>.cyberark.cloud`, the marketplace SPA at
`<tenant>-marketplace.cyberark.cloud`, Privilege Cloud's vault at `<tenant>-pcloud.cyberark.cloud`),
sharing one SSO session and cookie namespace. The extension moves an artifact between two services
of a platform the user already owns, using a session the user already holds, inside a perimeter
the user already trusts — it never talks to any host outside that one tenant's own services. This
single-platform, single-session structure is exactly why per-tenant optional host permissions are
sufficient and why no standing access is needed, and it was built with that in mind:

- **Permissions are optional and per-tenant, not standing.** The extension's whole reach is scoped
  to services of the one tenant the user is currently signed into — never a standing grant across
  tenants, and never access to any other vendor's product. The extension installs with no host
  access at all, and declares no API permissions (`optional_host_permissions`, not
  `host_permissions`, and no `permissions` key, in `extension/manifest.json`). Each tenant must be individually approved via a native Chrome
  permission prompt before the extension can act on it, and each grant is independently visible
  and revocable under **Site access** in `chrome://extensions`.
- **Every claim above is checkable directly in source:**
  - No standing host access: `extension/manifest.json`, `optional_host_permissions` vs. the
    absence of `host_permissions`.
  - Narrow, validated runtime requests: `originsToRequest` / `isAllowedOriginPattern` in
    `extension/background.js` and `src/origins.ts` — a wildcard pattern is refused before
    `chrome.permissions.request()` is ever called.
  - CSRF cookie handling: `readXsrfCookies` in `extension/content.js`, and `findXsrfCookie` /
    `xsrfCandidateNames` in `src/csrf.ts` with their call site in `extension/background.js` —
    note no cookie value is ever logged, for any cookie; only the selected cookie's name on
    success, or the XSRF-shaped candidate names on failure. There is no `chrome.cookies` call
    anywhere in the extension.
  - No storage of any kind: no calls to `chrome.storage`, `localStorage`, `sessionStorage`, or
    IndexedDB anywhere in `extension/` or `src/`.
  - No remote code: all files are local to the package; `extension/lib/*.js` is compiled from
    `src/*.ts` at build time and shipped, not fetched.
- **Known project-tracked caveats**, disclosed for transparency rather than hidden: the extension
  is a spike, verified end-to-end only against one connection-component product as a super-admin
  user on one test tenant; non-super-admin behavior and the platform (SRS) import path are not
  yet independently verified. These are functional-maturity caveats, not privacy or security gaps
  — they do not change any of the data-handling claims above. See `RELEASE-BLOCKERS.md` in the
  repository for the full, current list.
