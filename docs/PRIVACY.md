# Privacy Policy — Bellhop

> Bellhop carries integrations from the Idira Marketplace into Privilege Cloud, so you
> do not have to download a package and upload it again by hand. It currently
> supports Privilege Cloud connection components and platforms, and it never opens
> the package: the bytes are passed through unmodified so the signature stays valid.
>
> Not affiliated with or endorsed by Palo Alto Networks or CyberArk.

**Last updated:** 2026-09-09

## What this extension does

Bellhop adds an "Import into Privilege Cloud" button to a product page on the Idira
marketplace. Marketplace and Privilege Cloud are both services of the one Idira Identity Security
Platform tenant you are signed into, not separate products — the extension moves an artifact
between two services of a platform you already use. When clicked, it shows a confirmation dialog
naming the destination tenant, then downloads the selected integration artifact and uploads it
directly into that same tenant's Privilege Cloud, using the import API. It replaces the manual
step of downloading the artifact and uploading it by hand. The extension does nothing until the
user clicks this button.

## What data it accesses, and why

- **Marketplace product information.** When you view a product page, the extension reads that
  product's metadata from the marketplace's own API, using your existing marketplace session.
  This is the same data the page itself displays.
- **The artifact file.** After you confirm the import, the extension obtains a temporary,
  expiring download link for the integration artifact and fetches the file bytes from the
  vendor's own content host.
- **One cookie's value.** To satisfy your tenant's anti-CSRF (cross-site request forgery)
  protection, the extension asks Chrome for the cookies visible to your Privilege Cloud host and
  looks through their names for the one matching the pattern `XSRF-TOKEN-<id>` — the token your
  tenant already sets in your browser. Only that cookie's value is ever used, and it is sent back
  as a request header on the import request to that same tenant. No other cookie's value is read,
  used, or transmitted. (A failure-only diagnostic message, written to the browser console and
  never shown in the extension's UI, may note the *domain* — never the name or value — of other
  cookies visible at that scope, to help tell "no token cookie present" apart from "token cookie
  present but not matched.") The extension cannot read any cookie at all outside a tenant you have
  explicitly approved, because Chrome only allows an extension to read cookies for websites it
  currently has explicit permission to access (see Permissions, below).

## What it transmits, and to whom

The extension sends data to exactly two kinds of destination, both of which are places you
already have a relationship with — both are services of the one platform tenant you are signed
into, not a hand-off to a second vendor:

1. **Your own tenant** — the artifact file (base64-encoded, unmodified) and the CSRF token
   described above, sent to `https://<your-tenant>-pcloud.cyberark.cloud`, i.e. your own
   Privilege Cloud instance.
2. **The vendor's own content host** — a request for the artifact file itself, using a
   temporary download link the marketplace issued to you.

The extension does not send data anywhere else. There is no server operated by the publisher of
this extension. No data passes through the publisher, none of it is sold, and none is shared with
any third party.

## What it stores

Nothing. The extension does not use browser storage of any kind (no `chrome.storage`, no
`localStorage`, no `sessionStorage`, no IndexedDB), and it does not write any cookies. It keeps
no record of what you have imported, and nothing persists between browser sessions. There is
nothing for you to access, export, or delete, because nothing is retained after each import
completes.

## Analytics, tracking, and advertising

None. The extension contains no analytics, telemetry, crash reporting, or usage tracking of any
kind, and it does not sell or share data for advertising purposes.

## Code and execution

All of the extension's code ships inside the installed package. It does not download or run code
from a remote server, and it does not use `eval` or similar dynamic code execution. Nothing about
how it behaves can change after installation without a new version being published and installed.

## Permissions, in plain language

- **Reading cookies (`cookies` permission).** Used only to find and read the value of one
  anti-CSRF token cookie (`XSRF-TOKEN-<id>`), and only for tenants you have explicitly approved
  (see below).
- **Access to your tenant's site, granted one tenant at a time.** The extension does not have
  standing access to any site when first installed. The first time you use it against a given
  tenant, Chrome shows you a native permission prompt naming that exact tenant's address; nothing
  is accessed until you approve it. A tenant you have not approved is never touched.

The extension does not request, and cannot be granted through normal use, access to "all sites"
or to every customer tenant at once.

## How to revoke access

Because access is granted per tenant, you can review and remove it at any time:

1. Go to `chrome://extensions` (or `edge://extensions`).
2. Find "Bellhop" and open **Details**.
3. Under **Site access**, review the sites listed and remove any you no longer want the
   extension to access.

Removing the extension entirely also removes all granted access.

## Children's privacy

This extension is a professional tool for administrators of an enterprise product and is not
directed at children.

## Changes to this policy

Updates to this policy are reflected by a new **Last updated** date above. Any change to what
data is accessed, why, or where it goes will also be noted in this extension's release notes on
the Chrome Web Store and Microsoft Edge Add-ons listings.

## Contact

This extension is developed and maintained by Tim Schindler. For questions about this policy or
the extension's data handling, open an issue:
[github.com/aaearon/bellhop-marketplace-import/issues](https://github.com/aaearon/bellhop-marketplace-import/issues).

This policy is hosted at:
[github.com/aaearon/bellhop-marketplace-import/blob/main/docs/PRIVACY.md](https://github.com/aaearon/bellhop-marketplace-import/blob/main/docs/PRIVACY.md)
