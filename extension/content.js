// Import to tenant - content script (marketplace SPA iframe, ISOLATED world)
// Plain script, no imports/exports.

(function () {
  "use strict";

  var BTN_ID = "import-to-tenant-btn";
  var loggedProductDetail = false;
  var loggedDownloadResponse = false;

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

  // --- product detail / connection-component check ----------------------
  function isConnectionComponent(detail) {
    // Shape of /api/integrations/<uuid> is not confirmed. Known real
    // example: category "Idira platform & extensions", a PSM connection
    // component. Try a few plausible fields/values defensively.
    if (!detail || typeof detail !== "object") return false;

    var candidates = [
      detail.category,
      detail.categoryName,
      detail.type,
      detail.componentType,
      detail.integrationType,
      detail.subType,
    ];

    for (var i = 0; i < candidates.length; i++) {
      var v = candidates[i];
      if (typeof v !== "string") continue;
      var lower = v.toLowerCase();
      if (
        lower.indexOf("connection component") !== -1 ||
        lower.indexOf("idira platform") !== -1 ||
        lower === "psm"
      ) {
        return true;
      }
    }
    return false;
  }

  async function checkProductIsConnectionComponent(uuid) {
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
      return false;
    }

    if (!res.ok) {
      console.log(
        "[import-to-tenant] product detail request failed: status=%s",
        res.status
      );
      return false;
    }

    var detail;
    try {
      detail = await res.json();
    } catch (err) {
      console.log("[import-to-tenant] product detail response was not JSON");
      return false;
    }

    if (!loggedProductDetail) {
      loggedProductDetail = true;
      console.log(
        "[import-to-tenant] /api/integrations/%s raw response:",
        uuid,
        detail
      );
    }

    var result = isConnectionComponent(detail);
    if (!result) {
      console.log(
        "[import-to-tenant] product %s does not look like a connection component; not injecting button (fail closed).",
        uuid
      );
    }
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

  function makeImportButton(downloadBtn, uuid) {
    var btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.setAttribute("data-import-to-tenant-btn", "true");
    btn.className = downloadBtn.className;
    btn.style.marginLeft = "8px";
    btn.textContent = "Import to tenant";

    btn.addEventListener("click", function () {
      handleImportClick(btn, uuid);
    });

    return btn;
  }

  async function handleImportClick(btn, uuidAtClickTime) {
    btn.disabled = true;
    btn.textContent = "Importing…";

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

    var ok = await checkProductIsConnectionComponent(uuid);
    if (!ok) return;

    // Re-check after the await in case the SPA re-rendered or route changed.
    if (buttonPresent()) return;
    downloadBtn = findDownloadButton();
    if (!downloadBtn) return;

    var importBtn = makeImportButton(downloadBtn, uuid);
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
