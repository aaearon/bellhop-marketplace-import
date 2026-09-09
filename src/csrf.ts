export interface Cookie {
  name: string;
  value: string;
}

// Standard-form GUID: 8-4-4-4-12 hex digits, case-insensitive.
// The cookie NAME is matched case-sensitively against the literal
// "XSRF-TOKEN-" prefix (see case-sensitivity note below); only the
// hex digits of the guid itself are matched case-insensitively.
const XSRF_COOKIE_NAME_PATTERN =
  /^XSRF-TOKEN-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Selects the CSRF cookie matching `XSRF-TOKEN-<guid>` from a cookie list.
 *
 * Tie-break rule (design decision, for review): if multiple cookies match,
 * this returns the FIRST match in array order. Cookies are expected to come
 * from `document.cookie` / the `chrome.cookies` API in a stable order, and
 * in normal operation there should be exactly one XSRF cookie for the
 * tenant. First-match is the simplest deterministic rule and avoids adding
 * any implicit preference (e.g. sorting) that could silently pick the wrong
 * cookie if the caller's ordering assumptions change.
 *
 * Case sensitivity (design decision, for review): the `XSRF-TOKEN-` prefix
 * is matched case-SENSITIVELY. A cookie named e.g. `xsrf-token-<guid>` is
 * treated as a different cookie and will NOT match, consistent with cookie
 * names being conventionally exact-match in double-submit CSRF patterns.
 *
 * Security note: the cookie value is only ever returned to the caller via
 * this function's return value. It must not be logged (e.g. console.log)
 * or exposed through any other side channel.
 */
export function findXsrfCookie(cookies: Cookie[]): Cookie | null {
  for (const cookie of cookies) {
    if (XSRF_COOKIE_NAME_PATTERN.test(cookie.name)) {
      return cookie;
    }
  }
  return null;
}
