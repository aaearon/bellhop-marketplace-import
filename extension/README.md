# Bellhop

> Bellhop carries integrations from the Idira Marketplace into Privilege Cloud, so you
> do not have to download a package and upload it again by hand. It currently
> supports Privilege Cloud connection components and platforms, and it never opens
> the package: the bytes are passed through unmodified so the signature stays valid.
>
> Not affiliated with or endorsed by Palo Alto Networks or CyberArk.

A bellhop carries something you already own to a room you already have a key for,
without leaving the building — which is what this extension does, since the
Marketplace and Privilege Cloud are services of the same platform tenant, sharing
one session, so nothing crosses a trust boundary.

Idira is the Idira Identity Security Platform (formerly the CyberArk Identity Security
Platform); Marketplace and Privilege Cloud are services of that one platform, sharing a tenant
and session.

Adds an "Import to tenant" button next to Download on marketplace
connection-component product pages; the background service worker
downloads the signed zip and POSTs it to the tenant's
ConnectionComponents/Import endpoint.

## Build & load

1. `npm run build` — compiles `src/tenant.ts` and `src/base64.ts` into `extension/lib/`.
2. Go to `chrome://extensions`, enable Developer mode.
3. Click "Load unpacked" and select the `extension/` folder.

**Caveat:** spike quality — no retries, no error recovery, CSRF not
wired up, response shapes assumed and unconfirmed against live traffic.
