// Import to tenant - content script (marketplace SPA iframe, ISOLATED world)
// Plain script, no imports/exports.

(function () {
  "use strict";

  // Chrome match patterns cannot express a partial subdomain wildcard
  // ("*-marketplace.cyberark.cloud" is rejected as an invalid host wildcard),
  // so the manifest matches all of *.cyberark.cloud and we narrow here.
  if (!/(^|\.)[a-z0-9-]+-marketplace\.cyberark\.cloud$/i.test(location.hostname)) {
    return;
  }

  var BTN_ID = "import-to-tenant-btn";
  var loggedProductDetail = false;
  var loggedDownloadResponse = false;

  // Set while the confirmation dialog is open. Guards against the SPA
  // re-rendering underneath it and tryInject() injecting a second button
  // or a second dialog.
  var dialogOpen = false;

  var DIALOG_PREFIX = "import-to-tenant-dialog";

  var KIND_LABELS = {
    "connection-component": "PSM connection component",
    "platform": "Platform",
  };

  function getProductName(detail) {
    var value = detail && typeof detail === "object" ? detail.name : null;
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    return "this product";
  }

  // --- uuid extraction --------------------------------------------------
  // Ground truth for the exact route shape inside the marketplace iframe is
  // unknown at write time. We try a plausible uuid regex against the full
  // href and log what we find so it can be corrected later if wrong.
  var UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  function getCurrentUuid() {
    var match = location.href.match(UUID_RE);
    var uuid = match ? match[0] : null;
    console.log(
      "[import-to-tenant] getCurrentUuid: href=%s pathname=%s -> uuid=%s",
      location.href,
      location.pathname,
      uuid
    );
    return uuid;
  }

  // --- product detail / classification -----------------------------------
  // Classification logic lives in src/classify.ts (compiled to
  // extension/lib/classify.js) since it is covered by unit tests. This is a
  // plain content script with no ESM imports, so it delegates to the
  // service worker via messaging instead of duplicating the logic here. The
  // service worker also derives the destination tenant (via deriveOrigins)
  // from the origin we send it, so this script doesn't have to duplicate
  // hostname parsing to show it in the confirmation dialog.
  async function classifyViaBackground(detail) {
    try {
      return await chrome.runtime.sendMessage({
        type: "classify",
        detail: detail,
        origin: location.origin,
      });
    } catch (err) {
      console.log(
        "[import-to-tenant] classify message failed: %s",
        err && err.message
      );
      return null;
    }
  }

  // Returns { kind, tenant, pcloudOrigin, productName } for an importable
  // product, or null (fail closed) if it isn't one.
  async function checkProductKind(uuid) {
    var url = "/api/integrations/" + encodeURIComponent(uuid);
    var res;
    try {
      res = await fetch(url, { credentials: "same-origin" });
    } catch (err) {
      console.log(
        "[import-to-tenant] product detail fetch failed for %s: %s",
        uuid,
        err && err.message
      );
      return null;
    }

    if (!res.ok) {
      console.log(
        "[import-to-tenant] product detail request failed: status=%s",
        res.status
      );
      return null;
    }

    var detail;
    try {
      detail = await res.json();
    } catch (err) {
      console.log("[import-to-tenant] product detail response was not JSON");
      return null;
    }

    if (!loggedProductDetail) {
      loggedProductDetail = true;
      console.log(
        "[import-to-tenant] /api/integrations/%s raw response: %s",
        uuid,
        JSON.stringify(detail)
      );
    }

    var classification = await classifyViaBackground(detail);
    var kind = classification && classification.kind;

    if (!kind) {
      console.log(
        "[import-to-tenant] product %s did not classify to an importable kind; not injecting button (fail closed).",
        uuid
      );
      return null;
    }

    console.log(
      "[import-to-tenant] product %s classified as: %s",
      uuid,
      kind
    );

    var result = {
      kind: kind,
      tenant: classification.tenant,
      pcloudOrigin: classification.pcloudOrigin,
      productName: getProductName(detail),
    };

    // Front-loaded on purpose. contains() needs no user gesture, so asking it
    // here — well before the Import click — means the click handler can stay
    // fully synchronous up to the permissions.request() message, and a repeat
    // import into an already-granted tenant skips the prompt entirely.
    result.originPatterns = requiredOriginPatterns(result);
    result.alreadyGranted = await alreadyGranted(result.originPatterns);

    return result;
  }

  // --- download url extraction --------------------------------------------
  // Confirmed shape against a live tenant:
  // { url, expiresAt, expiresIn, fileName, sha256 }
  // fileName/sha256 may be null/empty and are not used in v1.
  async function fetchDownloadUrl(uuid) {
    var url = "/api/downloads/integrations/" + encodeURIComponent(uuid);
    var res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) {
      throw new Error("download request failed with status " + res.status);
    }

    var payload = await res.json();

    if (!loggedDownloadResponse) {
      loggedDownloadResponse = true;
      console.log(
        "[import-to-tenant] /api/downloads/integrations/%s raw response:",
        uuid,
        payload
      );
    }

    if (!payload || typeof payload.url !== "string") {
      throw new Error("could not find a download url in the response");
    }
    return payload.url;
  }

  // --- DOM: find/inject button --------------------------------------------
  function findDownloadButton() {
    var candidates = document.querySelectorAll("button, a");
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      var text = (el.textContent || "").trim();
      if (text === "Download" || text.indexOf("Download") === 0) {
        return el;
      }
    }
    return null;
  }

  function buttonPresent() {
    return !!document.getElementById(BTN_ID);
  }

  function makeImportButton(downloadBtn, uuid, classification) {
    var btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.setAttribute("data-import-to-tenant-btn", "true");
    btn.className = downloadBtn.className;
    btn.style.marginLeft = "8px";
    btn.textContent = "Import to tenant";

    btn.addEventListener("click", function () {
      openConfirmDialog(btn, uuid, classification);
    });

    return btn;
  }

  // --- optional host permissions -------------------------------------------
  // The extension ships with NO host permissions. The service worker's
  // cross-origin fetches (S3 artifact, import POST) and chrome.cookies both
  // need them, so the exact origins for THIS tenant are requested on the
  // dialog's Import click and granted per tenant.
  //
  // chrome.permissions is a "privileged_extension"-context API, so it is
  // undefined here in the content script — both calls are made by the service
  // worker on our behalf. contains() needs no gesture and is asked early (see
  // checkProductKind). request() does need one, and Chromium carries this
  // frame's transient user activation across the sendMessage hop, but only for
  // the synchronous portion of the click: see the comment on
  // handleImportClick.
  var S3_ORIGIN_PATTERN =
    "https://jenkinsmarketplacemaster-prod-content-eu-west-2.s3.eu-west-2.amazonaws.com/*";

  function requiredOriginPatterns(classification) {
    var patterns = [];
    if (classification && typeof classification.pcloudOrigin === "string" && classification.pcloudOrigin) {
      patterns.push(classification.pcloudOrigin.replace(/\/+$/, "") + "/*");
    }
    patterns.push(S3_ORIGIN_PATTERN);
    return patterns;
  }

  // Fails closed to false on any error: a false here only costs one extra
  // native prompt, never a silent import without permission.
  async function alreadyGranted(origins) {
    var result;
    try {
      result = await chrome.runtime.sendMessage({
        type: "permissionsContains",
        origins: origins,
      });
    } catch (err) {
      console.log(
        "[import-to-tenant] permissions.contains check failed: %s",
        err && err.message
      );
      return false;
    }
    return !!(result && result.ok);
  }

  // --- confirmation dialog -------------------------------------------------
  // Plain DOM built in the ISOLATED world, styled inline so it can't collide
  // with the host page's CSS. Deliberately not window.confirm/alert/prompt:
  // those block the page's event loop, can't show structure, and look like
  // a browser error rather than part of the product.
  function openConfirmDialog(triggerBtn, uuid, classification) {
    if (dialogOpen) return;
    dialogOpen = true;

    var kindLabel = KIND_LABELS[classification.kind] || classification.kind;
    var tenant = classification.tenant || "(unknown tenant)";
    var pcloudHost = classification.pcloudOrigin
      ? classification.pcloudOrigin.replace(/^https?:\/\//, "")
      : "(unknown host)";
    var titleId = DIALOG_PREFIX + "-title";

    var overlay = document.createElement("div");
    overlay.id = DIALOG_PREFIX + "-overlay";
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "background:rgba(0,0,0,0.5)",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "z-index:2147483647",
    ].join(";");

    var dialog = document.createElement("div");
    dialog.id = DIALOG_PREFIX;
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", titleId);
    dialog.style.cssText = [
      "background:#ffffff",
      "color:#1a1a1a",
      "border-radius:8px",
      "padding:24px",
      "max-width:420px",
      "width:90%",
      "box-shadow:0 8px 32px rgba(0,0,0,0.35)",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif",
      "box-sizing:border-box",
    ].join(";");

    var title = document.createElement("h2");
    title.id = titleId;
    title.textContent = "Import to Idira Privilege Cloud";
    title.style.cssText = "margin:0 0 16px;font-size:16px;font-weight:600;line-height:1.3;";

    var productLine = document.createElement("p");
    productLine.style.cssText = "margin:0 0 4px;font-size:14px;font-weight:600;";
    productLine.textContent = classification.productName;

    var kindLine = document.createElement("p");
    kindLine.style.cssText = "margin:0 0 16px;font-size:13px;color:#555;";
    kindLine.textContent = kindLabel;

    var tenantLabel = document.createElement("p");
    tenantLabel.style.cssText = "margin:0 0 2px;font-size:12px;color:#555;";
    tenantLabel.textContent = "Destination tenant:";

    var tenantValue = document.createElement("p");
    tenantValue.style.cssText = "margin:0 0 4px;font-size:20px;font-weight:700;word-break:break-word;";
    tenantValue.textContent = tenant;

    var hostValue = document.createElement("p");
    hostValue.style.cssText = [
      "margin:0 0 20px",
      "font-size:12px",
      "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
      "color:#666",
      "word-break:break-all",
    ].join(";");
    hostValue.textContent = pcloudHost;

    var btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";

    var cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.id = DIALOG_PREFIX + "-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText = [
      "padding:8px 16px",
      "border-radius:4px",
      "border:1px solid #ccc",
      "background:#f5f5f5",
      "color:#1a1a1a",
      "cursor:pointer",
      "font-size:14px",
    ].join(";");

    var importBtn = document.createElement("button");
    importBtn.type = "button";
    importBtn.id = DIALOG_PREFIX + "-import";
    importBtn.textContent = "Import";
    importBtn.style.cssText = [
      "padding:8px 16px",
      "border-radius:4px",
      "border:1px solid #0b5fff",
      "background:#0b5fff",
      "color:#ffffff",
      "cursor:pointer",
      "font-size:14px",
    ].join(";");

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(importBtn);

    dialog.appendChild(title);
    dialog.appendChild(productLine);
    dialog.appendChild(kindLine);
    dialog.appendChild(tenantLabel);
    dialog.appendChild(tenantValue);
    dialog.appendChild(hostValue);
    dialog.appendChild(btnRow);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    function close() {
      document.removeEventListener("keydown", onKeydown, true);
      if (overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
      dialogOpen = false;
      if (typeof triggerBtn.focus === "function") {
        triggerBtn.focus();
      }
    }

    function onCancel() {
      close();
    }

    function onImport() {
      close();
      handleImportClick(triggerBtn, uuid, classification);
    }

    // Simple two-button focus trap: the only focusable elements in the
    // dialog are Cancel and Import, so just wrap Tab/Shift+Tab between them.
    function onKeydown(ev) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        onCancel();
        return;
      }
      if (ev.key === "Tab") {
        if (ev.shiftKey) {
          if (document.activeElement === cancelBtn) {
            ev.preventDefault();
            importBtn.focus();
          }
        } else {
          if (document.activeElement === importBtn) {
            ev.preventDefault();
            cancelBtn.focus();
          }
        }
      }
    }

    overlay.addEventListener("click", function (ev) {
      if (ev.target === overlay) {
        onCancel();
      }
    });

    cancelBtn.addEventListener("click", onCancel);
    importBtn.addEventListener("click", onImport);
    document.addEventListener("keydown", onKeydown, true);

    cancelBtn.focus();
  }

  // NOT async, and nothing above the sendMessage below may await. This runs
  // synchronously inside the Import button's click event, which is what keeps
  // the frame's transient user activation live; Chromium attaches that bit to
  // the outgoing message and re-establishes an interaction scope around the
  // service worker's onMessage dispatch, which is what lets
  // chrome.permissions.request() run there. Disabling the button, relabelling
  // it and closing the dialog are plain DOM writes and are fine; an await or a
  // .then() hop before the message would not be.
  function handleImportClick(btn, uuidAtClickTime, classification) {
    btn.disabled = true;
    btn.textContent = "Importing…";

    // Checked at classification time, so no await is needed here.
    if (classification.alreadyGranted) {
      runImport(btn, uuidAtClickTime, classification);
      return;
    }

    chrome.runtime.sendMessage(
      {
        type: "permissionsRequest",
        origins: classification.originPatterns,
      },
      function (response) {
        // Fail closed: no host permission for this tenant, no import. Never
        // retried, never fallen back from.
        if (chrome.runtime.lastError) {
          console.log(
            "[import-to-tenant] permissions.request message failed: %s",
            chrome.runtime.lastError.message
          );
        } else if (response && response.error) {
          console.log("[import-to-tenant] permissions.request refused: %s", response.error);
        }

        if (!response || !response.ok) {
          btn.textContent = "Failed: permission not granted";
          return;
        }

        runImport(btn, uuidAtClickTime, classification);
      }
    );
  }

  async function runImport(btn, uuidAtClickTime, classification) {
    var kind = classification.kind;

    var downloadUrl;
    try {
      downloadUrl = await fetchDownloadUrl(uuidAtClickTime);
    } catch (err) {
      btn.textContent = "Failed: " + (err && err.message ? err.message : "could not get download url");
      return;
    }

    var response;
    try {
      response = await chrome.runtime.sendMessage({
        type: "import",
        downloadUrl: downloadUrl,
        uuid: uuidAtClickTime,
        origin: location.origin,
        kind: kind,
      });
    } catch (err) {
      btn.textContent = "Failed: " + (err && err.message ? err.message : "message failed");
      return;
    }

    if (response && response.ok) {
      btn.textContent = "Imported ✓";
    } else {
      var status = response && response.status;
      var body = response && response.body;
      var reason = status ? "HTTP " + status : "unknown error";
      if (body) {
        reason += " - " + String(body).slice(0, 120);
      }
      btn.textContent = "Failed: " + reason;
    }
  }

  // --- orchestration --------------------------------------------------------
  async function tryInject() {
    if (dialogOpen) return;
    if (buttonPresent()) return;

    var uuid = getCurrentUuid();
    if (!uuid) {
      console.log("[import-to-tenant] no uuid found in current url; skipping.");
      return;
    }

    var downloadBtn = findDownloadButton();
    if (!downloadBtn) {
      return; // Download button not on screen right now; nothing to anchor to.
    }

    var classification = await checkProductKind(uuid);
    if (!classification) return;

    // Re-check after the await in case the SPA re-rendered, the route
    // changed, or the confirmation dialog was opened in the meantime.
    if (dialogOpen) return;
    if (buttonPresent()) return;
    downloadBtn = findDownloadButton();
    if (!downloadBtn) return;

    var importBtn = makeImportButton(downloadBtn, uuid, classification);
    downloadBtn.insertAdjacentElement("afterend", importBtn);
  }

  var debounceTimer = null;
  function scheduleTryInject() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      debounceTimer = null;
      tryInject();
    }, 300);
  }

  var observer = new MutationObserver(function () {
    scheduleTryInject();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  scheduleTryInject();
})();
