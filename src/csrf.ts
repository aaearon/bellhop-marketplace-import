export interface Cookie {
  name: string;
  value: string;
  // Cookie scope, e.g. "tenant1.cyberark.cloud" (host-only) or
  // ".cyberark.cloud" (parent-domain, sent to every subdomain). Optional
  // because some callers (and existing tests) construct cookies without it.
  domain?: string;
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

/** Strips a leading "." so ".cyberark.cloud" and "cyberark.cloud" compare equal. */
function normalizeDomain(domain: string): string {
  return domain.startsWith(".") ? domain.slice(1) : domain;
}

/** True if `domain` (host-only or parent-domain, dot-prefixed or not) covers `targetHost`. */
function domainMatchesHost(domain: string, targetHost: string): boolean {
  const normalized = normalizeDomain(domain);
  return normalized === targetHost || targetHost.endsWith("." + normalized);
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
 * Selects the CSRF cookie matching `XSRF-TOKEN-<guid>` from a cookie list.
 *
 * Case sensitivity (design decision, for review): the `XSRF-TOKEN-` prefix
 * is matched case-SENSITIVELY. A cookie named e.g. `xsrf-token-<guid>` is
 * treated as a different cookie and will NOT match, consistent with cookie
 * names being conventionally exact-match in double-submit CSRF patterns.
 *
 * Multi-tenant disambiguation: `chrome.cookies.getAll({url})` returns every
 * cookie that WOULD BE SENT to that URL, including cookies scoped to a
 * parent domain (e.g. `.cyberark.cloud`) as well as the specific host.
 * Implementation partners can be authenticated to multiple customer tenants
 * at once, so more than one `XSRF-TOKEN-*` candidate can legitimately be
 * present at the same time. When `targetHost` is supplied, candidates are
 * ranked by domain specificity (an exact/host-only match beats a
 * parent-domain match) and any candidate whose domain does not cover
 * `targetHost` at all is excluded outright.
 *
 * Tie-break rule: if more than one candidate remains tied at the best
 * specificity level, this returns `null` rather than guessing. Picking
 * between tokens that may belong to different customer tenants is
 * unacceptable, so ambiguity fails closed instead of silently choosing one.
 * The same fail-closed rule applies when `targetHost` is omitted and more
 * than one candidate is present: there is no way to disambiguate, so we no
 * longer fall back to first-match-in-array-order.
 *
 * Security note: the cookie value is only ever returned to the caller via
 * this function's return value. It must not be logged (e.g. console.log)
 * or exposed through any other side channel.
 */
export function findXsrfCookie(cookies: Cookie[], targetHost?: string): Cookie | null {
  const candidates = cookies.filter(isXsrfCandidate);
  if (candidates.length === 0) {
    return null;
  }

  if (targetHost === undefined) {
    // No scope to disambiguate by: only safe when there is exactly one
    // candidate. Multiple candidates may belong to different tenants, so
    // fail closed rather than pick the first in array order.
    return candidates.length === 1 ? { name: candidates[0].name, value: candidates[0].value } : null;
  }

  let bestScore = -1;
  let bestMatches: Cookie[] = [];
  for (const cookie of candidates) {
    if (cookie.domain === undefined) {
      // Domain is unknown, so we cannot verify it is actually scoped to
      // targetHost. Tolerate the missing field (no throw) but exclude the
      // candidate rather than risk using an unrelated tenant's token.
      continue;
    }
    if (!domainMatchesHost(cookie.domain, targetHost)) {
      continue;
    }
    // Longer normalized domain == more specific scope (a host-only domain
    // equal to targetHost is the longest possible match; a parent domain
    // like "cyberark.cloud" is shorter and therefore less specific).
    const score = normalizeDomain(cookie.domain).length;
    if (score > bestScore) {
      bestScore = score;
      bestMatches = [cookie];
    } else if (score === bestScore) {
      bestMatches.push(cookie);
    }
  }

  if (bestMatches.length !== 1) {
    // Zero matches, or multiple candidates tied at the most specific scope
    // (possibly different tenants) — fail closed either way.
    return null;
  }

  const winner = bestMatches[0];
  return { name: winner.name, value: winner.value };
}
