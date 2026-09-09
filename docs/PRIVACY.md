# Privacy Policy — Idira Integration Importer

> Import integrations from the Idira Marketplace directly into your tenant. Not affiliated with
> or endorsed by Palo Alto Networks or CyberArk.

> **DRAFT — NOT LEGAL ADVICE.** This is an unreviewed engineering draft, written from the
> extension's source code, not a legal document. It must be reviewed and approved by the
> publisher's legal counsel before it is published or submitted anywhere. Two points counsel
> should weigh specifically: (1) the extension's name, "Idira Integration Importer," uses a
> third-party trademark ("Idira," Palo Alto Networks' rebrand of CyberArk), and (2) the
> integration it performs is not sanctioned by that vendor. Neither issue is addressed below;
> both are legal questions, not engineering ones.
>
> A privacy policy is good practice for a self-distributed security-adjacent tool even without a
> store requirement, so this document stays useful regardless of which distribution route
> (Chrome Web Store or GitHub/self-hosted) is chosen.

**Effective date:** [PLACEHOLDER: effective date]

## What this extension does

Idira Integration Importer adds an "Import to tenant" button to a product page on the Idira
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
- **One cookie.** To satisfy your tenant's anti-CSRF (cross-site request forgery) protection,
  the extension reads a single cookie — the `XSRF-TOKEN-<id>` token your tenant already sets in
  your browser — and sends its value back as a request header on the import request to that same
  tenant. This is the only cookie the extension reads. It does not read, and cannot read, any
  other cookie (including session or authentication cookies), because Chrome only allows an
  extension to read cookies for websites it currently has explicit permission to access, and this
  extension is never granted broad access (see Permissions, below).

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
this extension. No data passes through the publisher, and none is shared with any third party.

## What it stores

Nothing. The extension does not use browser storage of any kind (no `chrome.storage`, no
`localStorage`, no `sessionStorage`, no IndexedDB), and it does not write any cookies. It keeps
no record of what you have imported, and nothing persists between browser sessions.

## Analytics, tracking, and advertising

None. The extension contains no analytics, telemetry, crash reporting, or usage tracking of any
kind, and it does not sell or share data for advertising purposes.

## Code and execution

All of the extension's code ships inside the installed package. It does not download or run code
from a remote server, and it does not use `eval` or similar dynamic code execution. Nothing about
how it behaves can change after installation without a new version being published and installed.

## Permissions, in plain language

- **Reading one cookie (`cookies` permission).** Used only to read the anti-CSRF token described
  above, and only for tenants you have explicitly approved (see below).
- **Access to your tenant's site, granted one tenant at a time.** The extension does not have
  standing access to any site when first installed. The first time you use it against a given
  tenant, Chrome shows you a native permission prompt naming that exact tenant's address; nothing
  is accessed until you approve it. A tenant you have not approved is never touched.

The extension does not request, and cannot be granted through normal use, access to "all sites"
or to every customer tenant at once.

## How to revoke access

Because access is granted per tenant, you can review and remove it at any time:

1. Go to `chrome://extensions`.
2. Find "Idira Integration Importer" and open **Details**.
3. Under **Site access**, review the sites listed and remove any you no longer want the
   extension to access.

Removing the extension entirely also removes all granted access.

## Children's privacy

This extension is a professional tool for administrators of an enterprise product and is not
directed at children.

## Changes to this policy

[PLACEHOLDER: describe how and where updates to this policy will be announced, e.g. a changelog
at the hosted URL, a version note in the Chrome Web Store listing, etc.]

## Contact

Publisher: [PLACEHOLDER: publisher legal name]

Contact email: [PLACEHOLDER: contact email]

This policy is hosted at: [PLACEHOLDER: hosted URL]
