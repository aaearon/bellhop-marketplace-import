// Bellhop - background service worker (MV3, ES module)

import { deriveOrigins } from './lib/tenant.js';
import { arrayBufferToBase64 } from './lib/base64.js';
import { cookieDomains, findXsrfCookie, xsrfCandidateNames } from './lib/csrf.js';
import { classifyProduct, importPathFor, serviceDisplayNameFor } from './lib/classify.js';
import { isAllowedOriginPattern, s3OriginPatternFromDownloadUrl } from './lib/origins.js';

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

// --- message sender guard --------------------------------------------------
// Defence in depth, not a fix for a live hole. Today nothing but this
// extension's own content script can reach the listener below — there is no
// externally_connectable — and every value that matters is validated on its own
// (isValidKind, s3OriginPatternFromDownloadUrl, isAllowedOriginPattern). What
// this guards is a FUTURE manifest change: adding externally_connectable, or
// widening content_scripts.matches past the marketplace host, would otherwise
// silently hand an unrelated page the ability to drive
// chrome.permissions.request() and the import POST against a customer tenant,
// with nothing in this file objecting.
//
// Same hostname regex content.js narrows itself with on its first line, kept
// character-for-character identical on purpose: a stricter pattern here would
// reject the real content script on some host shape the content script itself
// accepts, and that failure would look like a broken extension rather than a
// mismatched allowlist.
var MARKETPLACE_HOST_RE = /(^|\.)[a-z0-9-]+-marketplace\.cyberark\.cloud$/i;

// Synchronous by construction — a property read, a URL parse and a regex, no
// await and no promise hop — because the permissionsRequest branch below runs
// inside the interaction scope Chromium wraps around this dispatch, and any
// asynchrony here would cost the user gesture and kill the native permission
// prompt. Do not make this async, and do not move any I/O into it.
function isTrustedSender(sender) {
  // A content script always has a tab; an extension page (options, popup) and
  // another extension's message do not.
  if (!sender || !sender.tab || typeof sender.tab.id !== "number") return false;
  // Our own extension, not another one. Lenient if the id is absent rather
  // than mismatched, since only same-extension messages arrive here at all.
  if (sender.id && sender.id !== chrome.runtime.id) return false;
  // The origin of the FRAME that sent the message. sender.origin is the direct
  // answer where available; sender.url is the frame url and carries the same
  // origin for the older shape.
  var from =
    typeof sender.origin === "string" && sender.origin ? sender.origin : sender.url;
  if (typeof from !== "string" || !from) return false;
  try {
    var u = new URL(from);
    return u.protocol === "https:" && MARKETPLACE_HOST_RE.test(u.hostname);
  } catch (err) {
    return false;
  }
}

// --- optional host permissions -------------------------------------------
// The origin allowlist and the artifact-origin validator live in
// src/origins.ts (compiled to extension/lib/origins.js) so they can be unit
// tested. Anything not on that allowlist is refused before
// chrome.permissions.request() is called, so a compromised or buggy caller
// cannot use the extension to solicit the wildcards that
// optional_host_permissions declares — `https://*.cyberark.cloud/*` (every
// tenant at once) or `https://*.amazonaws.com/*` (every AWS-hosted origin).
//
// The artifact origin is NOT supplied by the caller. The service worker
// derives it HERE, from the same download url it is itself about to fetch, so
// there is one source of truth and a hostile content script cannot talk the
// worker into requesting a grant for an attacker-chosen host by simply
// asserting "trust this origin".
//
// Synchronous by construction: this runs before request(), while the user
// activation carried across the sendMessage hop is still live.
function originsToRequest(baseOrigins, downloadUrl) {
  var origins = Array.isArray(baseOrigins) ? baseOrigins.slice() : [];

  var s3Pattern = s3OriginPatternFromDownloadUrl(downloadUrl);
  if (!s3Pattern) {
    return { ok: false, error: "invalid or missing artifact download url" };
  }
  origins.push(s3Pattern);

  if (!origins.every(isAllowedOriginPattern)) {
    return { ok: false, error: "unexpected origin requested" };
  }

  return { ok: true, origins: origins };
}

async function handleImport(msg) {
  var downloadUrl = msg.downloadUrl;
  var origin = msg.origin;
  var kind = msg.kind;

  if (!isValidKind(kind)) {
    var kindMsg = "invalid or missing kind: " + JSON.stringify(kind);
    console.log("[bellhop]", kindMsg);
    return { ok: false, status: 0, body: kindMsg, error: kindMsg };
  }

  // The artifact origin is derived and validated here too, from the very url
  // about to be fetched — the same check that gated the permission request.
  // Fail closed rather than fetching an origin we would never have asked for.
  if (!s3OriginPatternFromDownloadUrl(downloadUrl)) {
    var originMsg = "refusing to fetch artifact: invalid download origin";
    console.log("[bellhop] %s (%s)", originMsg, safeUrlForLog(downloadUrl));
    return { ok: false, status: 0, body: originMsg, error: originMsg };
  }

  console.log("[bellhop] fetching download url:", safeUrlForLog(downloadUrl));

  var s3Res;
  try {
    // No `credentials` option: this is a presigned URL, do not send
    // cookies/credentials to S3.
    s3Res = await fetch(downloadUrl);
  } catch (err) {
    var msgText = "S3 fetch failed: " + (err && err.message ? err.message : String(err));
    console.log("[bellhop]", msgText);
    return { ok: false, status: 0, body: msgText, error: msgText };
  }

  if (!s3Res.ok) {
    var failMsg =
      s3Res.status === 403
        ? "download link expired or rejected (403)"
        : "S3 fetch failed with status " + s3Res.status;
    console.log("[bellhop]", failMsg);
    return { ok: false, status: s3Res.status, body: failMsg, error: failMsg };
  }

  var buf = await s3Res.arrayBuffer();
  var bytes = new Uint8Array(buf);

  if (bytes.length < 2 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    var zipMsg = "not a valid zip (bad signature)";
    console.log("[bellhop]", zipMsg);
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
    console.log("[bellhop] %s (target %s)", noTokenMsg, origins.pcloudOrigin);
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
    "[bellhop] csrf cookie selected: name=%s domain=%s",
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
    "[bellhop] posting import to: %s (csrf cookie=%s, headers sent=%s)",
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
    console.log("[bellhop]", postMsg);
    return { ok: false, status: 0, body: postMsg, error: postMsg };
  }

  var bodyText = await importRes.text();
  var truncated = bodyText.slice(0, 500);

  // Console gets the FULL raw status and body — the UI may show a friendlier
  // wording (e.g. 409 -> "already imported"), but the raw detail must stay
  // available for debugging.
  console.log(
    "[bellhop] import response: status=%s body=%s",
    importRes.status,
    bodyText
  );

  return { ok: importRes.ok, status: importRes.status, body: truncated };
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message) return false;

  // Sender check ahead of every branch, and synchronous so it stays ahead of
  // permissionsRequest without costing it the user gesture (see
  // isTrustedSender). Fails closed with an explicit response rather than a
  // silent drop: every caller in content.js already treats a falsy/absent
  // response as "not granted" / "failed", so a rejected message surfaces as a
  // clear failure instead of a hung button.
  if (!isTrustedSender(sender)) {
    console.log(
      "[bellhop] refusing message type=%s from unexpected sender: id=%s frame=%s",
      message.type,
      (sender && sender.id) || "(none)",
      safeUrlForLog(sender && sender.url)
    );
    sendResponse({ ok: false, error: "unexpected sender" });
    return false;
  }

  // FIRST branch, and deliberately so. chrome.permissions.request() requires a
  // live user gesture. Chromium propagates the content script's transient user
  // activation across the sendMessage hop and wraps THIS listener invocation in
  // an interaction scope — but only for its synchronous portion. So there must
  // be no `await` (and no promise callback) anywhere between entering this
  // listener and calling request(); the origin validation below is synchronous
  // for exactly that reason, and request() is used in its callback form.
  if (message.type === "permissionsRequest") {
    var plan = originsToRequest(message.origins, message.downloadUrl);

    if (!plan.ok || plan.origins.length === 0) {
      console.log(
        "[bellhop] refusing permissions.request (%s) for: %s",
        plan.error || "empty origin set",
        JSON.stringify(message.origins)
      );
      sendResponse({ ok: false, error: plan.error || "unexpected origin requested" });
      return false;
    }

    var requested = plan.origins;

    chrome.permissions.request({ origins: requested }, function (granted) {
      if (chrome.runtime.lastError) {
        console.log(
          "[bellhop] permissions.request failed:",
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
        "[bellhop] classify threw unexpectedly:",
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
        "[bellhop] deriveOrigins failed for classify request:",
        err && err.message ? err.message : String(err)
      );
    }

    var serviceDisplayName = kind ? serviceDisplayNameFor(kind) : null;

    sendResponse({
      kind: kind,
      tenant: tenant,
      pcloudOrigin: pcloudOrigin,
      serviceDisplayName: serviceDisplayName,
    });
    return false; // synchronous response
  }

  // Purely informational: contains() has no user-gesture requirement, so this
  // one is free to be async. It is asked ahead of the Import click so an
  // already-granted tenant is never re-prompted.
  if (message.type === "permissionsContains") {
    // Same derivation as permissionsRequest, and deliberately so: the set
    // checked here must be exactly the set that would be requested, or an
    // "already granted" answer would let the import proceed without the
    // artifact origin.
    var containsPlan = originsToRequest(message.origins, message.downloadUrl);
    if (!containsPlan.ok || containsPlan.origins.length === 0) {
      sendResponse({ ok: false });
      return false;
    }

    chrome.permissions
      .contains({ origins: containsPlan.origins })
      .then(function (held) {
        sendResponse({ ok: !!held });
      })
      .catch(function (err) {
        var permMsg = err && err.message ? err.message : String(err);
        console.log("[bellhop] permissions.contains failed:", permMsg);
        sendResponse({ ok: false });
      });

    return true; // async response
  }

  if (message.type === "import") {
    handleImport(message)
      .catch(function (err) {
        var errMsg = err && err.message ? err.message : String(err);
        console.log("[bellhop] unexpected error:", errMsg);
        return { ok: false, status: 0, body: errMsg, error: errMsg };
      })
      .then(sendResponse);

    return true; // keep the message channel open for the async response
  }

  return false;
});
