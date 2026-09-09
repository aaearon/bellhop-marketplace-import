// [IDIRA-RECON] Diagnostic network observer.
//
// SECURITY: This script NEVER logs request/response bodies, NEVER logs
// request/response headers, and NEVER logs cookie or storage values.
// Only URLs, HTTP methods, and HTTP statuses are logged, via console.log.

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
        url: url,
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
      href: location.href,
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
