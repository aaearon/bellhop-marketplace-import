# Bellhop

Bellhop is a Chrome and Edge Manifest V3 extension that adds an "Import into Privilege Cloud" button to Idira Marketplace product pages, so an Idira (CyberArk) Privilege Cloud connection component or platform installs into the tenant's Privilege Cloud directly, replacing a manual download-then-upload round trip.

Not affiliated with or endorsed by Palo Alto Networks or CyberArk. This is an unsupported, spike-quality tool that writes directly into a production Privilege Cloud tenant — read [RELEASE-BLOCKERS.md](RELEASE-BLOCKERS.md) before pointing it at anything you care about.

## Why this isn't a trust boundary crossing

Idira is Palo Alto Networks' rebrand of CyberArk. Marketplace and Privilege Cloud aren't two vendors' products stitched together — they're sibling subdomains of one platform tenant, sharing one SSO session and cookie namespace. The extension moves an artifact from one service of that tenant to another, using a session the user already holds, inside a perimeter the user already trusts. A bellhop carries something you already own to a room you already have a key for, without leaving the building. Full argument: `docs/STORE-PERMISSIONS.md`, "Note for the reviewer".

## How it works

A content script in the marketplace iframe fetches the product's presigned S3 download URL on the same origin, using cookies it already has, and reads the tenant's CSRF token from `document.cookie` — it isn't HttpOnly, so this needs no permission at all. The artifact fetch and the import POST happen in the service worker rather than the content script, because a content script isn't CORS-exempt but an MV3 service worker holding a host permission for the target is. The extension declares no API permissions, and the worker requests exactly the two origins an import needs — the tenant's Privilege Cloud host, derived from the origin of the frame that sent the message, and the artifact's S3 host, derived at runtime from the download URL and never hardcoded. Full permission and origin-derivation model: `CLAUDE.md`.

## Screenshots

The button is injected next to the vendor's own Download button, cloned from it so it inherits the portal's styling:

![The Import into Privilege Cloud button beside the vendor's Download button](docs/images/injected-button.png)

Clicking it names the product, the package kind and the destination tenant before anything is written. The tenant shown here is a placeholder:

![The Bellhop confirmation dialog, naming the product, kind and destination tenant](docs/images/confirmation-dialog.png)

## Build and load

```
npm install
npm run build
```

Then `chrome://extensions` (or `edge://extensions`) → enable Developer mode → Load unpacked → select the `extension/` folder.

## Status

Confirmed:

- End-to-end import of one connection-component product into one live tenant, as a super admin — confirmation dialog, per-tenant optional permission grant, and CSRF handling all exercised. That run predates the current permission and CSRF shape, which has not yet been re-tested against a live tenant.

Untested:

- The platform (CPM/SRS) import path — implemented, never run against a live tenant.
- Any user below super admin.
- Two tenants authenticated at once. More than one CSRF token candidate fails closed rather than guessing.
- An artifact large enough to risk the service worker's ~30s idle lifetime; only a 308 KB artifact has been tried.

Full list, with risk for each: `RELEASE-BLOCKERS.md`.

## More

- `CLAUDE.md` — architecture, permissions model, auth, known limitations.
- [Privacy policy](https://aaearon.github.io/bellhop-marketplace-import/privacy/) — published from
  `docs/PRIVACY.md`; this is the URL submitted to the Chrome Web Store and Edge Add-ons.
- [Store permission justifications](https://aaearon.github.io/bellhop-marketplace-import/store-permissions/)
  — published from `docs/STORE-PERMISSIONS.md`.
- `RELEASE-BLOCKERS.md` — everything standing between this and a public release.
