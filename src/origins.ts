// Origin validation for chrome.permissions.request().
//
// The extension ships with NO host permissions; it requests the exact origins
// it needs, per tenant, on a user gesture. This module is the single place that
// decides what may ever be requested.
//
// The artifact origin is deliberately NOT hardcoded. It used to be the literal
// vendor bucket `jenkinsmarketplacemaster-prod-content-eu-west-2.s3...`, which
// is a Jenkins-generated internal name that changes without notice — when it
// changed, every installed copy broke silently and could only be fixed by
// shipping a store update. It is now derived at runtime from the presigned
// download url the service worker is itself about to fetch, and validated here.

/** A Chrome host match pattern, e.g. `https://example.com/*`. */
export type OriginPattern = string;

/** Every requestable S3 host must end with this. */
export const S3_HOST_SUFFIX = ".amazonaws.com";

/**
 * The bare apex, matched as an exact literal — never a regex, never a subdomain
 * wildcard. Needed only to read the parent-domain-scoped XSRF-TOKEN cookie; it
 * confers nothing on any tenant subdomain.
 */
export const APEX_ORIGIN_PATTERN: OriginPattern = "https://cyberark.cloud/*";

/**
 * The per-tenant vault host. The `*` sits OUTSIDE the character class, so no
 * host-wildcard pattern (`https://*.cyberark.cloud/*`) can ever match.
 */
export const PCLOUD_ORIGIN_PATTERN_RE = /^https:\/\/[a-z0-9-]+-pcloud\.cyberark\.cloud\/\*$/;

// A concrete DNS hostname: lowercase labels of alphanumerics/hyphens only.
// This is what rejects `*.amazonaws.com` — the WHATWG URL parser happily keeps
// `*` in a hostname (it is not a forbidden host code point), so `new URL()`
// alone would let the wildcard declaration through.
const CONCRETE_HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * True only for a concrete, requestable artifact origin: exactly
 * `https://<host>` where `<host>` is a real hostname ending in
 * `.amazonaws.com`, with no userinfo, no explicit port, no path/query/fragment
 * and no wildcard label.
 *
 * Fails closed on anything else, including the wildcard `https://*.amazonaws.com`
 * that `optional_host_permissions` declares — that string is a manifest
 * DECLARATION only and must never be requested.
 */
export function isValidS3Origin(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false;

  // Reject userinfo before parsing too: `user:pass@host` must never reach the
  // hostname check by having the parser quietly strip it.
  const withoutScheme = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  if (withoutScheme.split("/")[0]!.includes("@")) return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.port !== "") return false;

  // Bare origin only — no path, query or fragment.
  if (url.search !== "" || url.hash !== "") return false;
  if (url.pathname !== "" && url.pathname !== "/") return false;
  if (value.replace(/\/$/, "") !== url.origin) return false;

  const host = url.hostname;
  if (!CONCRETE_HOSTNAME_RE.test(host)) return false;
  // `.amazonaws.com` with a real label in front: this is what rejects the
  // lookalikes `evil-amazonaws.com` and `amazonaws.com.evil.com`.
  if (!host.endsWith(S3_HOST_SUFFIX)) return false;
  if (host.length <= S3_HOST_SUFFIX.length) return false;

  return true;
}

/** True for a concrete artifact origin in Chrome match-pattern form. */
export function isS3OriginPattern(pattern: unknown): boolean {
  if (typeof pattern !== "string") return false;
  if (!pattern.endsWith("/*")) return false;
  return isValidS3Origin(pattern.slice(0, -2));
}

/**
 * Derive the artifact origin pattern from the presigned download url the
 * service worker is about to fetch. Returns null (fail closed) if that url is
 * not a valid, concrete https S3 url — the caller must not request anything.
 */
export function s3OriginPatternFromDownloadUrl(downloadUrl: unknown): OriginPattern | null {
  if (typeof downloadUrl !== "string" || downloadUrl.length === 0) return null;

  let url: URL;
  try {
    url = new URL(downloadUrl);
  } catch {
    return null;
  }

  // Reject userinfo on the full url before reducing it to an origin, otherwise
  // `https://user:pass@host/x` would derive a clean-looking origin.
  if (url.username !== "" || url.password !== "") return null;

  const pattern = url.origin + "/*";
  return isS3OriginPattern(pattern) ? pattern : null;
}

/**
 * The runtime allowlist checked immediately before chrome.permissions.request().
 *
 * Synchronous by construction: it runs while the user activation carried across
 * the sendMessage hop is still live, so it must not await anything.
 */
export function isAllowedOriginPattern(pattern: unknown): boolean {
  if (typeof pattern !== "string") return false;
  return (
    pattern === APEX_ORIGIN_PATTERN ||
    PCLOUD_ORIGIN_PATTERN_RE.test(pattern) ||
    isS3OriginPattern(pattern)
  );
}
