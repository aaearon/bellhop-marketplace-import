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

function isXsrfCandidate(cookie: Cookie): boolean {
  return XSRF_COOKIE_NAME_PATTERN.test(cookie.name);
}

/**
 * Returns the names (never values) of every cookie whose name matches the
 * `XSRF-TOKEN-<guid>` pattern. Intended for diagnostics: this module must
 * never log a cookie value, and callers must never print one either.
 */
export function xsrfCandidateNames(cookies: Cookie[]): string[] {
  return cookies.filter(isXsrfCandidate).map((cookie) => cookie.name);
}

/**
 * Selects the CSRF cookie matching `XSRF-TOKEN-<guid>` from a list of
 * candidates read from `document.cookie` in the content script (see
 * `readXsrfCookies`, `extension/content.js`).
 *
 * Case sensitivity (design decision, for review): the `XSRF-TOKEN-` prefix
 * is matched case-SENSITIVELY. A cookie named e.g. `xsrf-token-<guid>` is
 * treated as a different cookie and will NOT match, consistent with cookie
 * names being conventionally exact-match in double-submit CSRF patterns.
 *
 * `document.cookie` exposes no domain/scope information, so there is
 * nothing to disambiguate candidates by beyond the name itself: if more
 * than one `XSRF-TOKEN-*` candidate is present at once (Idira partners can
 * be authenticated to multiple customer tenants at a time), there is no way
 * to tell which belongs to the current tenant. This returns `null` rather
 * than guessing — picking between tokens that may belong to different
 * tenants is unacceptable, so ambiguity fails closed instead of silently
 * choosing one (e.g. first-match-in-array-order).
 *
 * Domain-based disambiguation (ranking candidates by cookie scope via
 * `chrome.cookies`) existed here previously and was removed along with the
 * `chrome.cookies` permission; see git history if a future domain source
 * makes it worth reinventing.
 *
 * Security note: the cookie value is only ever returned to the caller via
 * this function's return value. It must not be logged (e.g. console.log)
 * or exposed through any other side channel.
 */
export function findXsrfCookie(cookies: Cookie[]): Cookie | null {
  const candidates = cookies.filter(isXsrfCandidate);
  // Only safe when there is exactly one candidate. Multiple candidates may
  // belong to different tenants, so fail closed rather than pick the first
  // in array order.
  return candidates.length === 1 ? { name: candidates[0].name, value: candidates[0].value } : null;
}
