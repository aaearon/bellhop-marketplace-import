// Import to tenant - background service worker (MV3, ES module)

import { deriveOrigins } from './lib/tenant.js';
import { arrayBufferToBase64 } from './lib/base64.js';
import { cookieDomains, findXsrfCookie, xsrfCandidateNames } from './lib/csrf.js';
import { classifyProduct, importPathFor } from './lib/classify.js';

function safeUrlForLog(url) {
  try {
    var u = new URL(url);
    return u.origin + u.pathname;
  } catch (err) {
    return "<invalid url>";
  }
}

function isValidKind(kind) {
  return kind === "connection-component" || kind === "platform";
}

// --- optional host permissions -------------------------------------------
// The only three origin patterns this extension ever needs. Anything else is
// refused before chrome.permissions.request() is called, so a compromised or
// buggy caller cannot use the extension to solicit the wildcard
// `https://*.cyberark.cloud/*` that optional_host_permissions declares (i.e.
// every tenant at once). The `*` is deliberately outside the character class
// below so no host-wildcard pattern can match.
var S3_ORIGIN_PATTERN =
  "https://jenkinsmarketplacemaster-prod-content-eu-west-2.s3.eu-west-2.amazonaws.com/*";
var PCLOUD_ORIGIN_PATTERN_RE = /^https:\/\/[a-z0-9-]+-pcloud\.cyberark\.cloud\/\*$/;
// The bare APEX, matched as an exact literal — never a regex, never a
// subdomain wildcard. chrome.cookies gates read access on the COOKIE's own
// domain scope, not on the url passed to getAll(): the tenant's
// XSRF-TOKEN-<guid> is scoped to the parent domain `.cyberark.cloud`, so
// Chrome checks permission against `https://cyberark.cloud/` and a grant of
// the exact pcloud origin alone leaves the cookie unreadable. This pattern
// grants nothing on any tenant subdomain.
var APEX_ORIGIN_PATTERN = "https://cyberark.cloud/*";

// Synchronous by construction: it runs before request() while the user
// activation carried across the sendMessage hop is still live.
function isAllowedOriginPattern(pattern) {
  if (typeof pattern !== "string") return false;
  return (
    pattern === S3_ORIGIN_PATTERN ||
    pattern === APEX_ORIGIN_PATTERN ||
    PCLOUD_ORIGIN_PATTERN_RE.test(pattern)
  );
}

async function handleImport(msg) {
  var downloadUrl = msg.downloadUrl;
  var origin = msg.origin;
  var kind = msg.kind;

  if (!isValidKind(kind)) {
    var kindMsg = "invalid or missing kind: " + JSON.stringify(kind);
    console.log("[import-to-tenant]", kindMsg);
    return { ok: false, status: 0, body: kindMsg, error: kindMsg };
  }

  console.log("[import-to-tenant] fetching download url:", safeUrlForLog(downloadUrl));

  var s3Res;
  try {
    // No `credentials` option: this is a presigned URL, do not send
    // cookies/credentials to S3.
    s3Res = await fetch(downloadUrl);
  } catch (err) {
    var msgText = "S3 fetch failed: " + (err && err.message ? err.message : String(err));
    console.log("[import-to-tenant]", msgText);
    return { ok: false, status: 0, body: msgText, error: msgText };
  }

  if (!s3Res.ok) {
    var failMsg =
      s3Res.status === 403
        ? "download link expired or rejected (403)"
        : "S3 fetch failed with status " + s3Res.status;
    console.log("[import-to-tenant]", failMsg);
    return { ok: false, status: s3Res.status, body: failMsg, error: failMsg };
  }

  var buf = await s3Res.arrayBuffer();
  var bytes = new Uint8Array(buf);

  if (bytes.length < 2 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    var zipMsg = "not a valid zip (bad signature)";
    console.log("[import-to-tenant]", zipMsg);
    return { ok: false, status: 0, body: zipMsg, error: zipMsg };
  }

  var b64 = arrayBufferToBase64(buf);

  var origins = deriveOrigins(origin);
  var importUrl = origins.pcloudApiBase + importPathFor(kind);

  // Double-submit CSRF: the tenant sets an XSRF-TOKEN-<guid> cookie whose
  // value must be echoed back in a header. Query by `url` so we get exactly
  // the cookies that would be sent to the pcloud origin (the SSO cookie may
  // be scoped to .cyberark.cloud rather than the pcloud host).
  var cookies = await chrome.cookies.getAll({ url: origins.pcloudOrigin });

  // Pass the pcloud HOSTNAME (not the origin url) as targetHost so
  // findXsrfCookie can rank candidates by domain specificity — a partner may
  // be signed in to several tenants at once, so a bare .cyberark.cloud token
  // must lose to a host-scoped one, and an unrelated tenant's token must be
  // excluded outright.
  var pcloudHost = new URL(origins.pcloudOrigin).hostname;
  var xsrf = findXsrfCookie(cookies, pcloudHost);

  if (!xsrf) {
    // Names and domains only, and only XSRF-shaped NAMES: this shows what was
    // rejected without printing unrelated cookie names (e.g. SSO tokens).
    // Never log a cookie VALUE. The cookie count and the distinct domains are
    // what distinguish the two failures that look identical from the outside:
    // "the cookie is not readable at this permission scope" (0 cookies, or
    // only host-scoped ones) vs "it is readable but no candidate matched".
    // Terse on purpose — this string is surfaced in the button label, which
    // truncates at 120 chars; the full target origin goes to the console only.
    var names = xsrfCandidateNames(cookies).join(", ") || "none";
    var domains = cookieDomains(cookies).join(", ") || "none";
    var noTokenMsg =
      "no usable XSRF-TOKEN cookie: " + cookies.length +
      " cookies, domains " + domains +
      ", XSRF-shaped: " + names;
    console.log("[import-to-tenant] %s (target %s)", noTokenMsg, origins.pcloudOrigin);
    return { ok: false, status: 0, body: noTokenMsg, error: noTokenMsg };
  }

  // Console only, never surfaced in the UI, and NEVER the value: records the
  // real-world scope of the token cookie so the permission model above stays
  // grounded in observation rather than inference. Matched on name+value so
  // the domain reported is the scope of the cookie actually selected, even if
  // the same name exists at two scopes.
  var selected = cookies.filter(function (c) {
    return c.name === xsrf.name && c.value === xsrf.value;
  })[0];
  console.log(
    "[import-to-tenant] csrf cookie selected: name=%s domain=%s",
    xsrf.name,
    (selected && selected.domain) || "(unknown)"
  );

  // The exact header name is NOT confirmed. Both conventional forms are sent:
  // an extra unrecognised header is harmless, a missing one fails the request.
  // Narrow this to the single correct header once observed.
  var headers = { "Content-Type": "application/json" };
  headers["X-XSRF-TOKEN"] = xsrf.value;
  headers["X-" + xsrf.name] = xsrf.value;

  console.log(
    "[import-to-tenant] posting import to: %s (csrf cookie=%s, headers sent=%s)",
    importUrl,
    xsrf.name,
    "X-XSRF-TOKEN, X-" + xsrf.name
  );

  var importRes;
  try {
    importRes = await fetch(importUrl, {
      method: "POST",
      credentials: "include",
      headers: headers,
      body: JSON.stringify({ ImportFile: b64 }),
    });
  } catch (err) {
    var postMsg = "import POST failed: " + (err && err.message ? err.message : String(err));
    console.log("[import-to-tenant]", postMsg);
    return { ok: false, status: 0, body: postMsg, error: postMsg };
  }

  var bodyText = await importRes.text();
  var truncated = bodyText.slice(0, 500);

  console.log(
    "[import-to-tenant] import response: status=%s body=%s",
    importRes.status,
    truncated
  );

  return { ok: importRes.ok, status: importRes.status, body: truncated };
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message) return false;

  // FIRST branch, and deliberately so. chrome.permissions.request() requires a
  // live user gesture. Chromium propagates the content script's transient user
  // activation across the sendMessage hop and wraps THIS listener invocation in
  // an interaction scope — but only for its synchronous portion. So there must
  // be no `await` (and no promise callback) anywhere between entering this
  // listener and calling request(); the origin validation below is synchronous
  // for exactly that reason, and request() is used in its callback form.
  if (message.type === "permissionsRequest") {
    var requested = Array.isArray(message.origins) ? message.origins : [];

    if (requested.length === 0 || !requested.every(isAllowedOriginPattern)) {
      console.log(
        "[import-to-tenant] refusing permissions.request for:",
        JSON.stringify(requested)
      );
      sendResponse({ ok: false, error: "unexpected origin requested" });
      return false;
    }

    chrome.permissions.request({ origins: requested }, function (granted) {
      if (chrome.runtime.lastError) {
        console.log(
          "[import-to-tenant] permissions.request failed:",
          chrome.runtime.lastError.message
        );
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      sendResponse({ ok: !!granted });
    });

    return true; // keep the channel open for the callback
  }

  if (message.type === "classify") {
    var kind;
    try {
      kind = classifyProduct(message.detail);
    } catch (err) {
      console.log(
        "[import-to-tenant] classify threw unexpectedly:",
        err && err.message ? err.message : String(err)
      );
      kind = null;
    }

    // Also derive the destination tenant identity so the content script
    // doesn't have to duplicate hostname parsing to show it in the
    // confirmation dialog.
    var tenant = null;
    var pcloudOrigin = null;
    try {
      var origins = deriveOrigins(message.origin);
      tenant = origins.tenant;
      pcloudOrigin = origins.pcloudOrigin;
    } catch (err) {
      console.log(
        "[import-to-tenant] deriveOrigins failed for classify request:",
        err && err.message ? err.message : String(err)
      );
    }

    sendResponse({ kind: kind, tenant: tenant, pcloudOrigin: pcloudOrigin });
    return false; // synchronous response
  }

  // Purely informational: contains() has no user-gesture requirement, so this
  // one is free to be async. It is asked ahead of the Import click so an
  // already-granted tenant is never re-prompted.
  if (message.type === "permissionsContains") {
    var origins = Array.isArray(message.origins) ? message.origins : [];
    if (origins.length === 0) {
      sendResponse({ ok: false });
      return false;
    }

    chrome.permissions
      .contains({ origins: origins })
      .then(function (held) {
        sendResponse({ ok: !!held });
      })
      .catch(function (err) {
        var permMsg = err && err.message ? err.message : String(err);
        console.log("[import-to-tenant] permissions.contains failed:", permMsg);
        sendResponse({ ok: false });
      });

    return true; // async response
  }

  if (message.type === "import") {
    handleImport(message)
      .catch(function (err) {
        var errMsg = err && err.message ? err.message : String(err);
        console.log("[import-to-tenant] unexpected error:", errMsg);
        return { ok: false, status: 0, body: errMsg, error: errMsg };
      })
      .then(sendResponse);

    return true; // keep the message channel open for the async response
  }

  return false;
});
