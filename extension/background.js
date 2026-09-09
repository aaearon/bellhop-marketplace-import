// Import to tenant - background service worker (MV3, ES module)

import { deriveOrigins } from './lib/tenant.js';
import { arrayBufferToBase64 } from './lib/base64.js';
import { findXsrfCookie } from './lib/csrf.js';
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
  var xsrf = findXsrfCookie(cookies);

  if (!xsrf) {
    var names = cookies.map(function (c) { return c.name; }).join(", ");
    var noTokenMsg =
      "no XSRF-TOKEN cookie found for " + origins.pcloudOrigin +
      " (cookies present: " + (names || "none") + ")";
    console.log("[import-to-tenant]", noTokenMsg);
    return { ok: false, status: 0, body: noTokenMsg, error: noTokenMsg };
  }

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
    sendResponse(kind);
    return false; // synchronous response
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
