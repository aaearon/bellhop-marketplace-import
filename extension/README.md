# Idira Integration Importer

> Import integrations from the Idira Marketplace directly into your tenant. Not affiliated with
> or endorsed by Palo Alto Networks or CyberArk.

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
