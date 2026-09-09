# Chrome Web Store Submission — Idira Integration Importer

> **Applies only if pursuing a Chrome Web Store submission** (listed or unlisted). If distribution
> goes the GitHub/self-hosted route instead, this document can be ignored entirely — see
> "Distribution method undecided" in `RELEASE-BLOCKERS.md`.

Draft text for the Web Store Developer Dashboard's "Privacy practices" and "Permissions
justification" fields. Each section below maps to one form field. Verified against
`extension/manifest.json`, `extension/content.js`, `extension/background.js`, `src/*.ts` on
`feat/import-to-tenant-spike`.

---

## Single purpose description

> Idira Integration Importer lets an administrator, on an Idira (CyberArk) marketplace product
> page, import a connection component or platform artifact directly into the same tenant's
> Privilege Cloud, replacing the manual download-then-upload workflow. It has no other function.

---

## Permission justifications

### `cookies`

**What it enables:** Reading the single `XSRF-TOKEN-<id>` cookie that the tenant sets for
double-submit CSRF protection, so its value can be echoed back as a request header on the import
POST. This is required — the tenant's Privilege Cloud import API rejects requests without it
(confirmed: the first import attempt without a CSRF header returned `HTTP 400 - CSRF validation
failed`, not an auth error, i.e. the session cookie itself was already accepted).

**Why there is no lesser alternative:** `chrome.cookies` is the only extension API that can read
a cookie value at all. The alternative — injecting a script into the tenant's own vault UI to read
the token from the page instead — was considered and rejected: it would require a host permission
on a live PAM (privileged access management) product's UI and running code inside it, a larger and
riskier surface than reading one named cookie. There is no scope narrower than `cookies` in the
Chrome permissions model.

**What it is not used for:** No cookie other than the one CSRF token is ever read. Diagnostic
logging (used only on failure, to distinguish "cookie unreadable at this permission scope" from
"cookie readable but no candidate matched") reports cookie *names* and *domains* only — never
values, and never for cookies outside the `XSRF-TOKEN` shape (`src/csrf.ts`,
`extension/background.js`). No cookie is ever written, and — because `chrome.cookies` access is
itself gated by the host permission described below — the extension has no cookie reach at all
until a specific tenant has been granted.

### Host permissions

**Declared, not granted at install.** `extension/manifest.json` lists every host pattern the
extension may ever ask for under `optional_host_permissions` — never under `host_permissions`.
On installation the extension holds **zero** host access. The three declared patterns are:

- `https://*.cyberark.cloud/*`
- `https://cyberark.cloud/*`
- `https://*.amazonaws.com/*`

**What is actually requested, at runtime, on the user's Import click** is never one of those
wildcards. It is exactly three specific origins, computed per import and validated against an
allowlist that rejects wildcard forms (`isAllowedOriginPattern`, `src/origins.ts`):

1. **The one tenant's Privilege Cloud host** — `https://<tenant>-pcloud.cyberark.cloud/*` — to
   POST the artifact to the tenant the user is currently viewing and confirmed in the dialog.
2. **The bare apex** — `https://cyberark.cloud/*`, an exact string, not a subdomain wildcard —
   needed only because the CSRF cookie above is scoped to `.cyberark.cloud`, and
   `chrome.cookies` gates read access on the cookie's own domain scope, not on the URL passed to
   it. Without this exact grant the token is unreadable even with the tenant's own pcloud origin
   granted. It confers no access to any tenant subdomain by itself.
3. **The specific artifact host** — derived at runtime from the presigned download URL the
   marketplace itself issues (an AWS-hosted content origin whose exact hostname is not fixed and
   is never hardcoded), so the artifact bytes can be fetched. This origin is derived by the
   extension from a URL the user's own marketplace session returned, not supplied by any other
   party.

**Why there is no lesser alternative:** The tenant hostname is not known until the user is on that
tenant's page, so `optional_host_permissions` must declare a pattern, not a fixed origin — Chrome
requires the *possible* scope to be declared even though nothing in that scope is granted. The
artifact bucket name is vendor-internal and changes without notice, so the same applies to
`*.amazonaws.com`. In both cases the declaration is the widest Chrome's model allows the extension
to *ask about*; the request is narrowed to one concrete host at the moment it is needed, and
`chrome.permissions.request()` is called with only that narrowed set — the wildcard pattern is
never passed to `request()`, and the code path that would do so is explicitly refused
(`background.js`, `originsToRequest` / `isAllowedOriginPattern`).

**What it is not used for:** No standing grant is ever created. A user who has approved tenant A
has no access granted to tenant B; each tenant requires its own explicit approval, shown as a
native Chrome permission prompt naming the exact origin. Nothing is granted silently, and nothing
is granted for a tenant the user has not clicked Import against.

### `content_scripts` — `all_frames: true`

**What it enables:** Running the content script inside every frame on a matched
`*.cyberark.cloud` page, not just the top-level document.

**Why there is no lesser alternative:** The Idira marketplace product page the button is injected
into is not the top-level document — the tenant UI is a shell page that loads the marketplace as
a nested, cross-origin iframe (and that iframe itself refuses to render as a top-level page). Only
`all_frames: true` reaches it. This setting does not grant any additional host access on its own —
a content script match is not a host permission, and the same-origin fetches it performs
(`/api/integrations/...`, `/api/downloads/integrations/...`) run using the page's own existing
session, needing no permission grant of any kind.

**What it is not used for:** The content script filters to the marketplace subdomain by hostname
regex on its first line and does nothing in any other frame it happens to run in — it does not
read or act on content in unrelated frames or pages.

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
| Authentication information | **Read, not collected** | The extension reads one CSRF cookie value and echoes it, in-request, as a header on a request to the same tenant it came from. The value is never transmitted to any other destination, never written to storage or disk, never logged (logs record only the cookie's name and domain), and never retained after the request completes. It is not "collected" in the sense of being gathered, stored, or reused — it is read once per import and used once, immediately, for the single request that needs it. |
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

This extension operates alongside a privileged-access-management (PAM) product
(CyberArk/Idira Privilege Cloud) and was built with that sensitivity in mind:

- **Permissions are optional and per-tenant, not standing.** The extension installs with no host
  access and no cookie reach at all (`optional_host_permissions`, not `host_permissions`, in
  `extension/manifest.json`). Each tenant must be individually approved via a native Chrome
  permission prompt before the extension can act on it, and each grant is independently visible
  and revocable under **Site access** in `chrome://extensions`.
- **Every claim above is checkable directly in source:**
  - No standing host access: `extension/manifest.json`, `optional_host_permissions` vs. the
    absence of `host_permissions`.
  - Narrow, validated runtime requests: `originsToRequest` / `isAllowedOriginPattern` in
    `extension/background.js` and `src/origins.ts` — a wildcard pattern is refused before
    `chrome.permissions.request()` is ever called.
  - CSRF cookie handling: `src/csrf.ts` (`findXsrfCookie`, `cookieDomains`,
    `xsrfCandidateNames`) and its call site in `extension/background.js` — note the value is
    never logged, only the cookie name/domain.
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
