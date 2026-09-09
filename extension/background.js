// Bellhop - background service worker (MV3, ES module)

import { deriveOrigins } from './lib/tenant.js';
import { arrayBufferToBase64 } from './lib/base64.js';
import { findXsrfCookie, xsrfCandidateNames } from './lib/csrf.js';
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

// The origin of the FRAME that sent the message, as CHROME reports it —
// never a value the message body carries. This is the single source of the
// destination tenant: every branch below derives the tenant from this, so a
// content script cannot name a tenant other than the one it is running on,
// and the tenant the confirmation dialog showed is necessarily the tenant the
// import POST lands in.
//
// sender.origin is the direct answer where available; sender.url is the frame
// url and carries the same origin for the older shape.
//
// Synchronous, like everything else on the permissionsRequest path (see the
// note on isTrustedSender below).
function senderOrigin(sender) {
  if (!sender) return null;
  var from =
    typeof sender.origin === "string" && sender.origin ? sender.origin : sender.url;
  if (typeof from !== "string" || !from) return null;
  try {
    return new URL(from).origin;
  } catch (err) {
    return null;
  }
}

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
  var from = senderOrigin(sender);
  if (!from) return false;
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
// NEITHER origin is supplied by the caller. The worker derives the tenant's
// pcloud host from sender.origin and the artifact host from the same download
// url it is itself about to fetch, so each has one source of truth and a
// hostile content script cannot talk the worker into requesting a grant for a
// host of its choosing by simply asserting "trust this origin".
//
// Two origins, not three: the bare cyberark.cloud apex used to be requested so
// chrome.cookies could read the parent-domain-scoped XSRF-TOKEN cookie. That
// cookie is not HttpOnly, so the content script reads it from document.cookie
// and neither the apex nor the `cookies` permission exists any more.
//
// Synchronous by construction: this runs before request(), while the user
// activation carried across the sendMessage hop is still live. deriveOrigins
// is pure string/URL work, so it costs nothing here.
function originsToRequest(sender, downloadUrl) {
  var tenantOrigins;
  try {
    tenantOrigins = deriveOrigins(senderOrigin(sender));
  } catch (err) {
    return { ok: false, error: "could not derive a tenant from the sender origin" };
  }

  var s3Pattern = s3OriginPatternFromDownloadUrl(downloadUrl);
  if (!s3Pattern) {
    return { ok: false, error: "invalid or missing artifact download url" };
  }

  var origins = [tenantOrigins.pcloudOrigin + "/*", s3Pattern];

  if (!origins.every(isAllowedOriginPattern)) {
    return { ok: false, error: "unexpected origin requested" };
  }

  return { ok: true, origins: origins };
}

async function handleImport(msg, sender) {
  var downloadUrl = msg.downloadUrl;
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

  // The destination comes from sender.origin, so it is the tenant whose page
  // sent the message and the tenant the confirmation dialog named — not a
  // tenant the message body could have chosen.
  var origins = deriveOrigins(senderOrigin(sender));
  var importUrl = origins.pcloudApiBase + importPathFor(kind);

  // Double-submit CSRF: the tenant sets an XSRF-TOKEN-<guid> cookie whose
  // value must be echoed back in a header. That cookie is not HttpOnly and is
  // scoped to the shared .cyberark.cloud parent domain, so the content script
  // reads it out of document.cookie and sends the XSRF-shaped candidates on
  // this message. The worker holds no `cookies` permission and makes no
  // chrome.cookies call.
  //
  // findXsrfCookie selects exactly one candidate or returns null. document.cookie
  // exposes no domain field, so there is nothing to rank candidates by — more
  // than one candidate may belong to different tenants, so ambiguity fails
  // closed rather than guessing. The content script's own name filter is only a
  // prefix test; the authoritative XSRF-TOKEN-<guid> match is this call.
  // Element shape is validated, not just the array: findXsrfCookie reads
  // `.name` off every element, so one null or malformed entry would throw a
  // TypeError and surface as a generic unexpected error instead of the
  // fail-closed CSRF message below. Every other field on this message is
  // validated; this one is too.
  var candidates = (Array.isArray(msg.xsrfCookies) ? msg.xsrfCookies : []).filter(function (c) {
    return c && typeof c.name === "string" && typeof c.value === "string";
  });
  var xsrf = findXsrfCookie(candidates);

  if (!xsrf) {
    // COUNTS only in the returned message, and names to the console only. The
    // cookie name carries the tenant session guid — the same reason the
    // X-<cookie name> header was dropped — and this string is rendered into
    // the button label, on a page the vendor's own SPA also occupies. The
    // diagnostic keeps its value either way: the two counts separate the
    // failures that look identical from the outside — nothing XSRF-shaped
    // reached us at all (the cookie is HttpOnly now, or host-scoped to pcloud
    // and invisible to that frame) vs. candidates arrived but none matched the
    // guid shape, or several did and it failed closed. Terse on purpose — the
    // label truncates at 120 chars.
    var names = xsrfCandidateNames(candidates);
    var noTokenMsg =
      "no usable XSRF-TOKEN cookie: " + candidates.length +
      " readable from the page, " + names.length + " guid-shaped";
    console.log(
      "[bellhop] %s (guid-shaped names: %s, target %s)",
      noTokenMsg,
      names.join(", ") || "none",
      origins.pcloudOrigin
    );
    return { ok: false, status: 0, body: noTokenMsg, error: noTokenMsg };
  }

  // Console only, never surfaced in the UI, and NEVER the value.
  console.log("[bellhop] csrf cookie selected: name=%s", xsrf.name);

  // X-XSRF-TOKEN, and only it. Confirmed against a live tenant by probing a
  // nonexistent path (CSRF middleware runs ahead of routing, so this was safe
  // and decisive): no header -> 400 CSRF validation failed; X-XSRF-TOKEN alone
  // -> 404, i.e. CSRF passed; X-<cookie name> alone -> 400. The second header
  // this used to send was both useless and a leak — the cookie name carries
  // the session guid.
  var headers = { "Content-Type": "application/json" };
  headers["X-XSRF-TOKEN"] = xsrf.value;

  console.log(
    "[bellhop] posting import to: %s (csrf cookie=%s)",
    importUrl,
    xsrf.name
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
    var plan = originsToRequest(sender, message.downloadUrl);

    if (!plan.ok || plan.origins.length === 0) {
      console.log(
        "[bellhop] refusing permissions.request: %s",
        plan.error || "empty origin set"
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
    // confirmation dialog. From sender.origin, not from the message: the
    // tenant the dialog names must be the tenant the import lands in.
    var tenant = null;
    var pcloudOrigin = null;
    try {
      var origins = deriveOrigins(senderOrigin(sender));
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
    var containsPlan = originsToRequest(sender, message.downloadUrl);
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
    handleImport(message, sender)
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
