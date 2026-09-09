// Bellhop - content script (marketplace SPA iframe, ISOLATED world)
// Plain script, no imports/exports.

(function () {
  "use strict";

  // Chrome match patterns cannot express a partial subdomain wildcard
  // ("*-marketplace.cyberark.cloud" is rejected as an invalid host wildcard),
  // so the manifest matches all of *.cyberark.cloud and we narrow here.
  if (!/(^|\.)[a-z0-9-]+-marketplace\.cyberark\.cloud$/i.test(location.hostname)) {
    return;
  }

  var BTN_ID = "bellhop-btn";
  var loggedProductDetail = false;
  var loggedDownloadResponse = false;

  // Set while the confirmation dialog is open. Guards against the SPA
  // re-rendering underneath it and tryInject() injecting a second button
  // or a second dialog.
  var dialogOpen = false;

  var DIALOG_PREFIX = "bellhop-dialog";

  var KIND_LABELS = {
    "connection-component": "PSM connection component",
    "platform": "Platform",
  };

  // --- logging safety ---------------------------------------------------
  // Mirrors safeUrlForLog() in extension/background.js: keeps the origin and
  // path (useful for diagnosis, carries nothing secret) and drops the query
  // string and fragment outright. Every url logged from this file goes
  // through it, because the artifact download url is a presigned AWS S3 link
  // whose query string carries live credentials (X-Amz-Signature,
  // X-Amz-Credential, X-Amz-Security-Token) — those must never reach the
  // page console. Do not re-widen this to log the full url.
  //
  // Never throws, on any input: a logging helper must not be able to break
  // the import path.
  function safeUrlForLog(url) {
    if (typeof url !== "string" || !url) return "(unparseable url)";
    try {
      var parsed = new URL(url, location.href);
      return parsed.origin + parsed.pathname;
    } catch (err) {
      return "(unparseable url)";
    }
  }

  function getProductName(detail) {
    var value = detail && typeof detail === "object" ? detail.name : null;
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    return "this product";
  }

  // The destination service name comes from the service worker's classify
  // response (src/classify.ts's serviceDisplayNameFor, round-tripped so this
  // script doesn't duplicate the kind -> service mapping). Falls back to a
  // generic label only if that field is ever missing, so the button/dialog
  // never render a blank.
  function idleLabelFor(classification) {
    var service =
      classification && typeof classification.serviceDisplayName === "string" && classification.serviceDisplayName
        ? classification.serviceDisplayName
        : "Privilege Cloud";
    return "Import into " + service;
  }

  // --- uuid extraction --------------------------------------------------
  // Ground truth for the exact route shape inside the marketplace iframe is
  // unknown at write time. We try a plausible uuid regex against the full
  // href and log what we find so it can be corrected later if wrong.
  var UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  // Deliberately SILENT, unlike every other read in this file. tryInject()
  // calls this on every debounced MutationObserver pass just to check that the
  // injected button still targets the product on screen, and the
  // overwhelmingly common answer is "it does" — logging that would bury every
  // other message in the console. The callers that actually act on the value
  // log it there instead (see tryInject).
  function readCurrentUuid() {
    var match = location.href.match(UUID_RE);
    return match ? match[0] : null;
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
        "[bellhop] classify message failed: %s",
        err && err.message
      );
      return null;
    }
  }

  // Returns { kind, tenant, pcloudOrigin, serviceDisplayName, productName }
  // for an importable product, or null (fail closed) if it isn't one.
  async function checkProductKind(uuid) {
    var url = "/api/integrations/" + encodeURIComponent(uuid);
    var res;
    try {
      res = await fetch(url, { credentials: "same-origin" });
    } catch (err) {
      console.log(
        "[bellhop] product detail fetch failed for %s: %s",
        uuid,
        err && err.message
      );
      return null;
    }

    if (!res.ok) {
      console.log(
        "[bellhop] product detail request failed: status=%s",
        res.status
      );
      return null;
    }

    var detail;
    try {
      detail = await res.json();
    } catch (err) {
      console.log("[bellhop] product detail response was not JSON");
      return null;
    }

    if (!loggedProductDetail) {
      loggedProductDetail = true;
      console.log(
        "[bellhop] /api/integrations/%s raw response: %s",
        uuid,
        JSON.stringify(detail)
      );
    }

    var classification = await classifyViaBackground(detail);
    var kind = classification && classification.kind;

    if (!kind) {
      console.log(
        "[bellhop] product %s did not classify to an importable kind; not injecting button (fail closed).",
        uuid
      );
      return null;
    }

    console.log(
      "[bellhop] product %s classified as: %s",
      uuid,
      kind
    );

    return {
      kind: kind,
      tenant: classification.tenant,
      pcloudOrigin: classification.pcloudOrigin,
      serviceDisplayName: classification.serviceDisplayName,
      productName: getProductName(detail),
    };
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
      // NEVER log `payload` wholesale. payload.url is a presigned S3 link and
      // its query string carries live AWS credentials — see safeUrlForLog.
      // The remaining fields are non-secret and are the ones worth having
      // when a download goes wrong (an expired link, a missing artifact).
      console.log(
        "[bellhop] /api/downloads/integrations/%s response: url=%s expiresAt=%s expiresIn=%s fileName=%s sha256=%s",
        uuid,
        safeUrlForLog(payload && payload.url),
        payload && payload.expiresAt,
        payload && payload.expiresIn,
        payload && payload.fileName,
        payload && payload.sha256
      );
    }

    if (!payload || typeof payload.url !== "string") {
      throw new Error("could not find a download url in the response");
    }
    return payload.url;
  }

  // --- DOM: find/inject button --------------------------------------------
  //
  // Anchor strategies, tried in order of durability (most durable first),
  // each falling through to the next on failure. Strategies 1-3 were
  // confirmed against a live product-info page (Oracle SQL Developer for VS
  // Code, acme-poc tenant, connection-component kind, 2026-09-09) by
  // dumping the Download button and its ancestors from inside the content
  // script itself (see CLAUDE.md "Injection anchor" for the full observed
  // markup and which parts are guesses vs. observed).
  //
  // Every strategy excludes the extension's own injected button, since it is
  // inserted as a sibling right after the anchor and would otherwise be
  // re-matched by a later MutationObserver pass.
  function isOwnButton(el) {
    return !!el && (el.id === BTN_ID || el.hasAttribute("data-bellhop-btn"));
  }

  // Strategy 1 — OBSERVED. The vendor renders the Download button with
  // data-testid="item-download". Test ids exist for the vendor's own
  // automated UI tests and are generally stable across localisation/copy
  // changes; they are not immune to a vendor refactor, but that is a much
  // rarer event than a copy or language change.
  function findByTestId() {
    var el = document.querySelector('[data-testid="item-download"]');
    return el && !isOwnButton(el) ? el : null;
  }

  // Strategy 2 — OBSERVED. The Download button's icon is
  // <span class="... cyb-icon-size-sm cyb-icon-download-04">, part of the
  // portal's own "cyb-icon-*" glyph font. The glyph name ("download") is a
  // language-independent signal. Matches any "cyb-icon-download" prefixed
  // class rather than the exact "-04" suffix, in case that numeral is a
  // style/version variant rather than part of the glyph name — GUESS: only
  // the "-04" suffix was actually observed, the prefix match is a hedge.
  var ICON_CLASS_RE = /\bcyb-icon-download\b|\bcyb-icon-download-\d+\b/;
  function findByIconClass() {
    var icons = document.querySelectorAll('[class*="cyb-icon-download"]');
    for (var i = 0; i < icons.length; i++) {
      if (!ICON_CLASS_RE.test(icons[i].className)) continue;
      var btn = icons[i].closest("button, a");
      if (btn && !isOwnButton(btn)) return btn;
    }
    return null;
  }

  // Strategy 3 — OBSERVED, but on a single product only (GUESS that the same
  // structure holds for platform-kind products, which were not checked live
  // — see Classification in CLAUDE.md). The Download button's parent is
  // <div class="item-header__row">, alongside the product identity block
  // (logo/title/author) — an authored, semantic class name, not a build-hash
  // attribute (this portal is React/PrimeReact under the hood, judging by
  // the p-button/p-component classes and data-pc-* attributes; there is no
  // Angular _ngcontent-* anywhere in the observed markup). Falls back to the
  // last non-own button in that row, on the theory that Download is the
  // rightmost vendor action there and Import is always inserted after it.
  function findByHeaderRow() {
    var row = document.querySelector(".item-header__row");
    if (!row) return null;
    var buttons = row.querySelectorAll("button, a");
    for (var i = buttons.length - 1; i >= 0; i--) {
      if (!isOwnButton(buttons[i])) return buttons[i];
    }
    return null;
  }

  // Strategy 4 — LAST RESORT, kept only as a safety net. Case-insensitive
  // visible-text / aria-label match against a small set of known English
  // labels. This is the ONLY strategy that breaks under localisation or a
  // vendor copy change — exactly the bug the strategies above exist to route
  // around.
  var TEXT_LABELS = ["download"];
  function findByText() {
    var candidates = document.querySelectorAll("button, a");
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (isOwnButton(el)) continue;
      var text = (el.textContent || "").trim().toLowerCase();
      var aria = (el.getAttribute("aria-label") || "").trim().toLowerCase();
      for (var j = 0; j < TEXT_LABELS.length; j++) {
        var label = TEXT_LABELS[j];
        if (text === label || text.indexOf(label) === 0 || aria === label) {
          return el;
        }
      }
    }
    return null;
  }

  var ANCHOR_STRATEGIES = [
    ["data-testid=item-download", findByTestId],
    ["icon class cyb-icon-download*", findByIconClass],
    ["header row structure (.item-header__row)", findByHeaderRow],
    ["text match (last resort)", findByText],
  ];

  // Logged once per outcome (not every call) so a broken-anchor page doesn't
  // spam the console on every MutationObserver-triggered retry, while still
  // making a future break diagnosable from the console alone.
  var loggedAnchorStrategy = false;
  var loggedAnchorMissing = false;

  function findAnchorButton() {
    for (var i = 0; i < ANCHOR_STRATEGIES.length; i++) {
      var name = ANCHOR_STRATEGIES[i][0];
      var el = ANCHOR_STRATEGIES[i][1]();
      if (el) {
        if (!loggedAnchorStrategy) {
          loggedAnchorStrategy = true;
          console.log("[bellhop] anchor button found via strategy: %s", name);
        }
        return el;
      }
    }
    if (!loggedAnchorMissing) {
      loggedAnchorMissing = true;
      console.log(
        "[bellhop] no anchor strategy matched the Download button; not injecting (fail closed)."
      );
    }
    return null;
  }

  function buttonPresent() {
    return !!document.getElementById(BTN_ID);
  }

  // --- loading affordance --------------------------------------------------
  // openConfirmDialog awaits a fetch (the download url) and a permissions
  // check before it renders anything, so the click needs its own feedback
  // for that gap or it reads as broken. The spinner is a small inline CSS
  // animation injected once, prefixed "bellhop-" so it can't collide with the
  // host SPA's styles; it respects prefers-reduced-motion by simply not
  // being shown (falls back to the "Preparing…" text alone).
  var SPINNER_STYLE_ID = "bellhop-spinner-style";
  var BTN_LOADING_CLASS = "bellhop-btn-loading";

  function ensureSpinnerStyles() {
    if (document.getElementById(SPINNER_STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = SPINNER_STYLE_ID;
    style.textContent = [
      ".bellhop-spinner {",
      "  display:inline-block;",
      "  width:10px;",
      "  height:10px;",
      "  margin-right:6px;",
      "  vertical-align:-1px;",
      "  border:2px solid currentColor;",
      "  border-right-color:transparent;",
      "  border-radius:50%;",
      "}",
      "@media (prefers-reduced-motion: no-preference) {",
      "  .bellhop-spinner { animation: bellhop-spin .6s linear infinite; }",
      "}",
      "@media (prefers-reduced-motion: reduce) {",
      "  .bellhop-spinner { display:none; }",
      "}",
      "@keyframes bellhop-spin { to { transform: rotate(360deg); } }",
    ].join("\n");
    document.head.appendChild(style);
  }

  // Centralized label mutation: the button's visible text lives inside
  // PrimeReact's inner <span class="p-button-label">, not on the <button>
  // itself (cloneNode preserves that structure — see makeImportButton).
  // Writing textContent on the <button> directly would wipe that span and
  // any sibling nodes (e.g. the loading spinner), so every place that
  // changes the visible label goes through here instead.
  function setButtonLabel(btn, text) {
    var label = btn.querySelector(".p-button-label");
    if (label) {
      label.textContent = text;
    } else {
      btn.textContent = text;
    }
  }

  // Synchronous, called before any await in the click handler. Inserts the
  // spinner as a child positioned before the label span (rather than
  // clearing/replacing the button's contents) so the PrimeReact structure
  // copied from the vendor's Download button survives.
  function setButtonLoading(btn) {
    btn.disabled = true;
    btn.classList.add(BTN_LOADING_CLASS);
    var spinner = document.createElement("span");
    spinner.className = "bellhop-spinner";
    spinner.setAttribute("aria-hidden", "true");
    var label = btn.querySelector(".p-button-label");
    if (label) {
      btn.insertBefore(spinner, label);
    } else {
      btn.appendChild(spinner);
    }
    setButtonLabel(btn, "Preparing…");
  }

  // No classification is in scope here (only btn), so the idle label is read
  // back from data-idle-label, stashed on the element at construction time in
  // makeImportButton -- rather than threading classification through the
  // click handler chain just for this.
  function clearButtonLoading(btn) {
    btn.disabled = false;
    btn.classList.remove(BTN_LOADING_CLASS);
    var spinner = btn.querySelector(".bellhop-spinner");
    if (spinner && spinner.parentNode) {
      spinner.parentNode.removeChild(spinner);
    }
    setButtonLabel(btn, btn.dataset.idleLabel || "Import into Privilege Cloud");
  }

  function makeImportButton(downloadBtn, uuid, classification) {
    ensureSpinnerStyles();

    var idleLabel = idleLabelFor(classification);

    // downloadBtn is only ever the vendor's genuine Download button here:
    // every findAnchorButton() strategy excludes isOwnButton() results, so
    // this never clones our own previously-injected button.
    var btn = downloadBtn.cloneNode(true);
    btn.removeAttribute("id");
    btn.removeAttribute("data-testid");
    btn.removeAttribute("name");
    // cloneNode never copies JS listeners, but strip any inline
    // onclick-style attribute defensively anyway.
    btn.removeAttribute("onclick");
    btn.id = BTN_ID;
    btn.setAttribute("data-bellhop-btn", "true");
    btn.setAttribute("aria-label", idleLabel);
    // The product this button was built for, recorded ON the element. The click
    // handler below captures `uuid` and `classification` by closure, so a
    // button that outlives the product it was built for is a button that
    // imports the wrong artifact — and nothing in the DOM would say so. This
    // stamp is what lets tryInject() tell "the button on screen belongs to the
    // product on screen" from "the SPA changed product underneath it"; see the
    // identity check there for the full failure mode.
    btn.dataset.bellhopUuid = uuid;
    // Stashed here, not threaded as a parameter: clearButtonLoading only has
    // the <button> in scope (no classification), so it reads the idle label
    // back from the element rather than duplicating this computation.
    btn.dataset.idleLabel = idleLabel;
    btn.style.marginLeft = "8px";

    // Outlined variant: the clone inherits PrimeReact's exact typography,
    // padding and sizing, and this modifier changes only the fill. Download is
    // the vendor's primary action on this page, so ours sits beside it as the
    // secondary action rather than competing as a second filled button.
    btn.classList.add("p-button-outlined");

    // A download glyph is wrong for an import action; PrimeReact renders
    // label-only buttons fine without it.
    var icon = btn.querySelector(".p-button-icon");
    if (icon && icon.parentNode) {
      icon.parentNode.removeChild(icon);
    }

    // Never set textContent on the <button> itself here — write into the
    // inner .p-button-label span so PrimeReact's structure (and styling)
    // survives. Fall back to plain textContent, loudly, if the vendor
    // markup ever stops having that span so the breakage is diagnosable.
    var label = btn.querySelector(".p-button-label");
    if (label) {
      label.textContent = idleLabel;
    } else {
      console.warn(
        "[bellhop] cloned Download button had no .p-button-label span; falling back to plain textContent on the button."
      );
      btn.textContent = idleLabel;
    }

    btn.addEventListener("click", function () {
      // Re-entrancy guard: a click while already loading (or otherwise
      // disabled) must not fire a second fetch or open a second dialog.
      if (btn.disabled) return;

      // Identity guard, the click-time half of the check in tryInject().
      // tryInject() removes and rebuilds this button when the SPA changes
      // product, but it only runs on a 300ms-debounced MutationObserver pass;
      // a click landing between an in-place route change and that pass would
      // otherwise start an import of the PREVIOUS product's artifact into a
      // live tenant while the page already shows the new one. Synchronous and
      // essentially free, and the failure it prevents (a wrong write into a
      // production tenant) cannot be undone. Removing itself here rather than
      // just returning keeps the two paths agreeing on what a stale button is.
      var uuidNow = readCurrentUuid();
      if (uuidNow !== uuid) {
        console.log(
          "[bellhop] ignoring click: this button was built for product %s but the page is now on %s; removing it.",
          uuid,
          uuidNow || "(no uuid in url)"
        );
        if (btn.parentNode) btn.parentNode.removeChild(btn);
        scheduleTryInject();
        return;
      }

      // Synchronous, before any await: this is the affordance for the gap
      // while openConfirmDialog awaits its fetch + permissions check.
      setButtonLoading(btn);

      (async function () {
        try {
          // openConfirmDialog is async (it resolves the download url before
          // it renders). Reset the guard if it throws, or the button would
          // be dead.
          await openConfirmDialog(btn, uuid, classification);
        } catch (err) {
          dialogOpen = false;
          console.log(
            "[bellhop] confirmation dialog failed to open: %s",
            err && err.message ? err.message : String(err)
          );
        } finally {
          // Covers every path: the dialog rendered (normal case, including
          // the pre-dialog fetch having failed — the dialog still opens with
          // Import disabled), the early dialogOpen guard returned without
          // rendering, or openConfirmDialog threw. The button is never left
          // stuck showing the spinner.
          clearButtonLoading(btn);
        }
      })();
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
  // worker on our behalf. contains() needs no gesture and is asked at
  // dialog-open (see openConfirmDialog). request() does need one, and Chromium
  // carries this frame's transient user activation across the sendMessage hop,
  // but only for the synchronous portion of the click: see the comment on
  // handleImportClick.
  //
  // The artifact (S3) origin is deliberately NOT listed here. The vendor bucket
  // is a Jenkins-generated name that changes without notice, so the service
  // worker derives that origin itself from the download url it is about to
  // fetch — this script never names or asserts it.
  //
  // The bare apex, and only the bare apex. The tenant's XSRF-TOKEN-<guid> is a
  // parent-domain (.cyberark.cloud) SSO cookie, and chrome.cookies gates read
  // access on the cookie's own domain scope rather than the url passed to
  // getAll() — so without this grant the token is unreadable even with the
  // exact pcloud origin granted. It confers nothing on any tenant subdomain.
  var APEX_ORIGIN_PATTERN = "https://cyberark.cloud/*";

  function requiredOriginPatterns(classification) {
    var patterns = [];
    if (classification && typeof classification.pcloudOrigin === "string" && classification.pcloudOrigin) {
      patterns.push(classification.pcloudOrigin.replace(/\/+$/, "") + "/*");
    }
    patterns.push(APEX_ORIGIN_PATTERN);
    return patterns;
  }

  // Fails closed to false on any error: a false here only costs one extra
  // native prompt, never a silent import without permission. downloadUrl is
  // passed so the worker derives and appends the artifact origin itself —
  // the set checked must be exactly the set that would later be requested.
  async function alreadyGranted(origins, downloadUrl) {
    var result;
    try {
      result = await chrome.runtime.sendMessage({
        type: "permissionsContains",
        origins: origins,
        downloadUrl: downloadUrl,
      });
    } catch (err) {
      console.log(
        "[bellhop] permissions.contains check failed: %s",
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
  async function openConfirmDialog(triggerBtn, uuid, classification) {
    if (dialogOpen) return;
    dialogOpen = true;

    // Fetch the presigned download url HERE — at dialog-open — and nowhere
    // else. Two constraints pin it to this exact point:
    //
    //  * NOT at button-injection time. The url is presigned with a 600s TTL;
    //    a user who leaves the product page open and idle would arrive at the
    //    dialog holding an expired link.
    //  * NOT in the Import click handler. chrome.permissions.request() needs
    //    transient user activation, which decays within a few seconds of the
    //    click, and this is a network round trip. Awaiting it inside the click
    //    would blow the activation window and the native prompt would be
    //    refused.
    //
    // Awaited here, so by the time the Import button can be clicked the url is
    // resolved and cached and the click handler stays synchronous up to the
    // permissions.request() message. This is also the freshest the url can be
    // while still being ready before the click.
    var downloadUrl = null;
    var downloadError = null;
    try {
      downloadUrl = await fetchDownloadUrl(uuid);
    } catch (err) {
      downloadError =
        err && err.message ? err.message : "could not get download url";
      console.log(
        "[bellhop] download url fetch failed at dialog open: %s",
        downloadError
      );
    }

    // contains() needs no user gesture, so it is asked here rather than on the
    // click; a repeat import into an already-granted tenant then skips the
    // native prompt entirely.
    var originPatterns = requiredOriginPatterns(classification);
    var plan = {
      downloadUrl: downloadUrl,
      originPatterns: originPatterns,
      alreadyGranted: downloadUrl
        ? await alreadyGranted(originPatterns, downloadUrl)
        : false,
    };

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
      // Two named custom properties, both from the Idira palette the icon
      // set uses (sourced from the brand SVG at
      // marketplace.idira.pan.dev/brand/idira-marketplace.svg).
      //
      // The chrome is charcoal, not blue, deliberately. The Import button
      // below is #0b5fff, near-identical to Idira's own #265BFF, so a blue
      // border and heading would wash this dialog into vendor blue and
      // defeat the point of branding it as the extension's own UI.
      // Charcoal is the one part of the palette the vendor UI does not use
      // as chrome, so it reads as deliberate rather than as a mimic.
      "--bellhop-accent:#141414",
      // The mark stays Idira blue so it ties back to the toolbar icon.
      "--bellhop-mark:#265bff",
      "background:#ffffff",
      "color:#1a1a1a",
      "border-radius:8px",
      "border-top:4px solid var(--bellhop-accent)",
      "padding:24px",
      "max-width:420px",
      "width:90%",
      "box-shadow:0 8px 32px rgba(0,0,0,0.35)",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif",
      "box-sizing:border-box",
    ].join(";");

    // Brand header: identifies this dialog as Bellhop's own UI, not the
    // marketplace's, before the user reads anything else. Mark is an inline
    // SVG (a simple parcel glyph, echoing the extension's icon set) rather
    // than a chrome.runtime.getURL(...) reference to the packaged PNGs —
    // that would need those icons declared under web_accessible_resources
    // in manifest.json, which is out of scope for this change (another
    // change is touching the manifest). The glyph deliberately mirrors the
    // shipped 16/32px mark: a plain box with a white lid and NO ribbon.
    // The ribbon was removed from the icon because at small sizes a
    // high-contrast band across the box destroys the parcel silhouette —
    // the same reasoning applies at this glyph's 18px, so the two must not
    // drift apart. Fill reads var(--bellhop-mark).
    var brandRow = document.createElement("div");
    brandRow.style.cssText = "display:flex;align-items:center;gap:8px;margin:0 0 4px;";

    var brandMark = document.createElement("span");
    brandMark.setAttribute("aria-hidden", "true");
    brandMark.style.cssText = "display:inline-flex;width:18px;height:18px;flex:0 0 18px;";
    brandMark.innerHTML = [
      '<svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">',
      '<rect x="3" y="9" width="18" height="12" rx="2" fill="var(--bellhop-mark)"/>',
      '<path d="M3 9 L6 4 L21 4 L18 9 Z" fill="#ffffff" stroke="var(--bellhop-mark)" stroke-width="1.5" stroke-linejoin="round"/>',
      "</svg>",
    ].join("");

    var brandName = document.createElement("span");
    brandName.textContent = "Bellhop";
    brandName.style.cssText = "font-size:14px;font-weight:700;color:var(--bellhop-accent);letter-spacing:0.02em;";

    brandRow.appendChild(brandMark);
    brandRow.appendChild(brandName);

    var brandSubtitle = document.createElement("p");
    brandSubtitle.style.cssText = "margin:0 0 16px;font-size:11px;color:#666;";
    brandSubtitle.textContent = "Browser extension. Not part of Idira.";

    var title = document.createElement("h2");
    title.id = titleId;
    // Same wording (and the same "into") as the button label, both derived
    // from idleLabelFor's classification.serviceDisplayName -- this used to
    // be a separate hardcoded string ("Import to Idira Privilege Cloud") that
    // had already drifted from the button. Dropping the "Idira" qualifier:
    // per CLAUDE.md, Marketplace and Privilege Cloud are services of the one
    // Idira platform, not separate products, so "Idira Privilege Cloud" is
    // not this service's actual name -- "Privilege Cloud" is, matching the
    // button and the manifest description.
    title.textContent = idleLabelFor(classification);
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

    // Fail closed and say so. The dialog still opens — cancelling it must stay
    // possible and the user needs to see why — but nothing importable exists
    // without a download url, so Import is disabled rather than offered and
    // left to fail. No retry, no fallback.
    var errorLine = null;
    if (downloadError) {
      errorLine = document.createElement("p");
      errorLine.id = DIALOG_PREFIX + "-error";
      errorLine.style.cssText = [
        "margin:0 0 16px",
        "font-size:13px",
        "color:#b00020",
        "word-break:break-word",
      ].join(";");
      errorLine.textContent = "Cannot import: " + downloadError;

      importBtn.disabled = true;
      importBtn.style.cursor = "not-allowed";
      importBtn.style.opacity = "0.5";
    }

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(importBtn);

    dialog.appendChild(brandRow);
    dialog.appendChild(brandSubtitle);
    dialog.appendChild(title);
    dialog.appendChild(productLine);
    dialog.appendChild(kindLine);
    dialog.appendChild(tenantLabel);
    dialog.appendChild(tenantValue);
    dialog.appendChild(hostValue);
    if (errorLine) dialog.appendChild(errorLine);
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
      if (importBtn.disabled) return;
      close();
      handleImportClick(triggerBtn, uuid, classification, plan);
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
  function handleImportClick(btn, uuidAtClickTime, classification, plan) {
    btn.disabled = true;
    setButtonLabel(btn, "Importing…");

    // Resolved at dialog-open time, so no await is needed here.
    if (plan.alreadyGranted) {
      runImport(btn, classification, plan);
      return;
    }

    chrome.runtime.sendMessage(
      {
        type: "permissionsRequest",
        origins: plan.originPatterns,
        // The worker derives and validates the artifact origin from this url
        // itself; it does not take an origin on our word.
        downloadUrl: plan.downloadUrl,
      },
      function (response) {
        // Fail closed: no host permission for this tenant, no import. Never
        // retried, never fallen back from.
        if (chrome.runtime.lastError) {
          console.log(
            "[bellhop] permissions.request message failed: %s",
            chrome.runtime.lastError.message
          );
        } else if (response && response.error) {
          console.log("[bellhop] permissions.request refused: %s", response.error);
        }

        if (!response || !response.ok) {
          setButtonLabel(btn, "Failed: permission not granted");
          return;
        }

        runImport(btn, classification, plan);
      }
    );
  }

  // The download url was resolved when the dialog opened (see
  // openConfirmDialog) and is reused verbatim here, so the origin the worker
  // was granted permission for is the origin it actually fetches.
  async function runImport(btn, classification, plan) {
    var kind = classification.kind;

    var response;
    try {
      response = await chrome.runtime.sendMessage({
        type: "import",
        downloadUrl: plan.downloadUrl,
        origin: location.origin,
        kind: kind,
      });
    } catch (err) {
      setButtonLabel(btn, "Failed: " + (err && err.message ? err.message : "message failed"));
      return;
    }

    if (response && response.ok) {
      setButtonLabel(btn, "Imported ✓");
    } else {
      var status = response && response.status;
      var body = response && response.body;

      // Still a failure, styled and flowed exactly like any other. Only the
      // wording differs: a re-import returns 409 with a long ErrorCode blob
      // that this label would truncate mid-sentence into nonsense. The raw
      // status and body stay in the console (and in the service worker log).
      console.log(
        "[bellhop] import failed: status=%s body=%s",
        status,
        body
      );

      // 409 means the item is already present. That is a non-success, but it is
      // not a failure the user must act on, so it reads as a plain statement
      // rather than "Failed: Already imported...", which contradicts itself.
      // The absence of the success tick still distinguishes it visually.
      if (status === 409) {
        setButtonLabel(btn, "Already imported into this tenant");
      } else {
        var reason = status ? "HTTP " + status : "unknown error";
        if (body) {
          reason += " - " + String(body).slice(0, 120);
        }
        setButtonLabel(btn, "Failed: " + reason);
      }
    }
  }

  // --- orchestration --------------------------------------------------------
  async function tryInject() {
    // A dialog is open: leave the button alone entirely, stale or not. Beyond
    // avoiding a second injection, the open dialog holds a direct reference to
    // this element (triggerBtn) for its focus return and for every label write
    // on the import path — rebuilding underneath it would leave the import
    // reporting into a detached node. The product the dialog names was captured
    // when it opened and is the one the user is being asked to confirm; the
    // rebuild happens on the next pass after it closes.
    if (dialogOpen) return;

    var currentUuid = readCurrentUuid();
    var existing = document.getElementById(BTN_ID);

    // --- product identity check ---------------------------------------------
    // This replaces a bare "a button already exists, so there is nothing to
    // do". That is only true if the button on screen was built for the product
    // on screen. Its click handler captures the uuid AND the classification of
    // whichever render created it, so the two can silently diverge: the
    // marketplace is a React SPA, and if it ever moves from product A to
    // product B by mutating the existing header in place rather than tearing it
    // down, our button is never removed, the old early return fires, and the
    // stale button goes on importing A's artifact into a live production tenant
    // while the page reads B. A wrong import is a real write to a customer
    // tenant and cannot be undone, so identity is checked rather than assumed.
    if (existing) {
      if (currentUuid && existing.dataset.bellhopUuid === currentUuid) {
        return; // Button matches the product on screen. The common case.
      }

      // Two cases are removed here, deliberately together: a stamp for a
      // different product, and no readable uuid at all. The second is the
      // interesting one, and removal is still the safe answer — a button whose
      // destination we cannot verify is worse than no button. Leaving it up
      // means continuing to offer an import whose target we would be guessing
      // at; removing it costs the user at most a page reload, and the next
      // mutation pass re-injects on its own the moment a uuid is readable
      // again. Fail closed, exactly as findAnchorButton and checkProductKind do.
      console.log(
        "[bellhop] removing import button: it was built for product %s, the page is now on %s.",
        existing.dataset.bellhopUuid || "(unstamped)",
        currentUuid || "(no uuid in url)"
      );
      if (existing.parentNode) existing.parentNode.removeChild(existing);
    }

    // Logged only on the paths that act — the identity fast path above returns
    // before this, so an idle, correct page stays quiet. The url is redacted
    // through safeUrlForLog: this frame is handed to us by the tenant's SSO
    // shell, so its query/fragment can carry session handoff params. The uuid,
    // the only part actually needed, is logged alongside it.
    console.log(
      "[bellhop] current url=%s -> uuid=%s",
      safeUrlForLog(location.href),
      currentUuid
    );

    if (!currentUuid) {
      console.log("[bellhop] no uuid found in current url; skipping.");
      return;
    }

    var uuid = currentUuid;

    var downloadBtn = findAnchorButton();
    if (!downloadBtn) {
      return; // Anchor button not on screen right now (or no strategy matched); nothing to anchor to.
    }

    // A rebuild deliberately goes through the same path as a first injection:
    // classification is per product (kind, destination service, display name,
    // and the import endpoint that follows from it), so it must be re-derived
    // for the CURRENT uuid. Nothing is carried over from the button that was
    // just removed, and there is deliberately no cache to shortcut through —
    // reusing A's classification for B is the same wrong-artifact bug wearing a
    // different hat.
    var classification = await checkProductKind(uuid);
    if (!classification) return;

    // Re-check after the await in case the SPA re-rendered, the route
    // changed, or the confirmation dialog was opened in the meantime. The uuid
    // is part of that re-check: a route change during the classify round trip
    // would otherwise inject a button stamped with (and closed over) a product
    // the page has already navigated away from.
    if (dialogOpen) return;
    if (buttonPresent()) return;
    if (readCurrentUuid() !== uuid) {
      console.log(
        "[bellhop] product changed while classifying %s; not injecting.",
        uuid
      );
      return;
    }
    downloadBtn = findAnchorButton();
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
