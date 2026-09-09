// [IDIRA-RECON] Diagnostic network observer.
//
// SECURITY: This script NEVER logs request/response bodies, NEVER logs
// request/response headers, and NEVER logs cookie or storage values.
// Only URLs, HTTP methods, and HTTP statuses are logged, via console.log.
//
// SECURITY: URLs are NOT inherently safe to log as-is either - this app
// mints presigned AWS S3 URLs whose QUERY STRING carries a live credential
// (X-Amz-Security-Token, X-Amz-Signature, X-Amz-Credential, etc). Every
// logged URL is passed through redactUrl() below, which keeps the origin,
// path, and query parameter NAMES but replaces query/fragment VALUES with
// a redacted placeholder (see redactUrl for the narrow harmless-param
// allowlist).

(function () {
  if (window.__idiraRecon) {
    // Already injected in this frame (e.g. re-run) - bail out.
    return;
  }
  window.__idiraRecon = true;

  var STATIC_ASSET_EXTENSIONS = [
    '.woff2', '.ttf', '.otf', '.png', '.jpg', '.jpeg', '.svg', '.gif',
    '.webp', '.css', '.ico', '.map'
  ];

  var TELEMETRY_HOSTS = ['mixpanel.com', 'intercom.io', 'cloudfront.net'];

  function getFrameId() {
    try {
      return location.origin + location.pathname;
    } catch (e) {
      return 'unknown-frame';
    }
  }

  function hostMatches(host, suffix) {
    return host === suffix || (host.length > suffix.length &&
      host.slice(-(suffix.length + 1)) === '.' + suffix);
  }

  // Harmless, non-secret query params - kept verbatim for readability.
  var URL_PARAM_KEEP_PATTERN = /^(v|version|page|size|limit|offset|sort|order|lang|locale|t)$/i;
  // Always fully redacted, even if it happens to match the allowlist above.
  var URL_PARAM_ALWAYS_REDACT_PATTERN = /token|sig|signature|credential|key|secret|password|auth|session/i;

  // Redact a URL for logging: keeps origin + pathname + query parameter
  // NAMES verbatim, but replaces every query/fragment VALUE with
  // '<redacted:N>' (N = character length) - never the value itself. See the
  // SECURITY comment at the top of this file for why this is mandatory on
  // every log path, not just the sensitive-looking ones.
  function redactUrl(rawUrl) {
    try {
      var parsed = new URL(rawUrl, location.href);
      var query = '';
      if (parsed.search) {
        var params = new URLSearchParams(parsed.search);
        var parts = [];
        params.forEach(function (value, name) {
          var keep = URL_PARAM_KEEP_PATTERN.test(name) &&
            !URL_PARAM_ALWAYS_REDACT_PATTERN.test(name);
          parts.push(encodeURIComponent(name) + '=' + (keep ?
            encodeURIComponent(value) :
            '<redacted:' + String(value).length + '>'));
        });
        if (parts.length) {
          query = '?' + parts.join('&');
        }
      }
      var fragment = '';
      if (parsed.hash) {
        var hashBody = parsed.hash.slice(1);
        fragment = (hashBody.indexOf('=') === -1 && hashBody.indexOf('&') === -1) ?
          parsed.hash :
          '#<redacted>';
      }
      return parsed.origin + parsed.pathname + query + fragment;
    } catch (e) {
      // Parsing failed - fall back to the portion before the first '?',
      // never the query string itself (that's where credentials live).
      try {
        var str = String(rawUrl);
        var qIdx = str.indexOf('?');
        return qIdx === -1 ? str : str.slice(0, qIdx);
      } catch (e2) {
        return '';
      }
    }
  }

  function shouldFilter(rawUrl) {
    try {
      var parsed = new URL(rawUrl, location.href);
      var path = parsed.pathname.toLowerCase();
      for (var i = 0; i < STATIC_ASSET_EXTENSIONS.length; i++) {
        if (path.slice(-STATIC_ASSET_EXTENSIONS[i].length) === STATIC_ASSET_EXTENSIONS[i]) {
          return true;
        }
      }
      var host = parsed.hostname.toLowerCase();
      for (var j = 0; j < TELEMETRY_HOSTS.length; j++) {
        if (hostMatches(host, TELEMETRY_HOSTS[j])) {
          return true;
        }
      }
      return false;
    } catch (e) {
      // If URL parsing fails, don't filter - err on the side of logging.
      return false;
    }
  }

  function logCall(method, url, status, type) {
    try {
      if (shouldFilter(url)) {
        return;
      }
      console.log('[IDIRA-RECON]', JSON.stringify({
        frame: getFrameId(),
        method: method,
        url: redactUrl(url),
        status: status,
        type: type
      }));
    } catch (e) {
      // Never let logging errors propagate.
    }
  }

  // Log the frame tree once at startup, independent of any network call.
  try {
    console.log('[IDIRA-FRAME]', JSON.stringify({
      origin: location.origin,
      href: redactUrl(location.href),
      isTop: window.top === window.self
    }));
  } catch (e) {
    // Swallow - never break the host page.
  }

  // --- Patch window.fetch ---
  try {
    var originalFetch = window.fetch;
    if (typeof originalFetch === 'function') {
      window.fetch = function (input, init) {
        var method = 'GET';
        var url = '';
        try {
          if (init && init.method) {
            method = init.method;
          } else if (input && typeof input === 'object' && input.method) {
            method = input.method;
          }
          url = (typeof input === 'string') ? input : (input && input.url) || '';
        } catch (e) {
          // Ignore extraction errors - still perform the real call below.
        }

        var result = originalFetch.apply(this, arguments);

        try {
          result.then(function (response) {
            try {
              logCall(method, url, response ? response.status : undefined, 'fetch');
            } catch (e) {
              // Swallow logging errors.
            }
          }, function () {
            try {
              logCall(method, url, 'error', 'fetch');
            } catch (e) {
              // Swallow logging errors.
            }
          });
        } catch (e) {
          // Swallow - never affect the real fetch call/result.
        }

        return result;
      };
    }
  } catch (e) {
    // Swallow - fetch patching must never break the host page.
  }

  // --- Patch XMLHttpRequest ---
  try {
    var OriginalOpen = XMLHttpRequest.prototype.open;
    var OriginalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        this.__idiraMethod = method;
        this.__idiraUrl = url;
      } catch (e) {
        // Swallow.
      }
      return OriginalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function () {
      try {
        var self = this;
        var method = this.__idiraMethod || 'GET';
        var url = this.__idiraUrl || '';
        this.addEventListener('loadend', function () {
          try {
            logCall(method, url, self.status, 'xhr');
          } catch (e) {
            // Swallow logging errors.
          }
        });
      } catch (e) {
        // Swallow - never affect the real send call.
      }
      return OriginalSend.apply(this, arguments);
    };
  } catch (e) {
    // Swallow - XHR patching must never break the host page.
  }
})();
