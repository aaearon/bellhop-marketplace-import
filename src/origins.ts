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

// The bare apex `https://cyberark.cloud/*` used to be requestable, purely so
// `chrome.cookies` could read the parent-domain-scoped XSRF-TOKEN cookie —
// Chrome gates cookie reads on the cookie's own domain scope, so the pcloud
// grant alone was not enough. That token is not HttpOnly, so the content
// script now reads it from `document.cookie` with no host permission at all,
// and the apex is neither declared nor requested. There is deliberately no
// rule below that any `cyberark.cloud` form other than a concrete
// `<tenant>-pcloud` host can satisfy.

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

// An S3 endpoint label. Anchored at both ends, so `s3cret` and `s3x` are not
// S3 endpoint labels. Three families, and only these three:
//   - `s3`                — the modern endpoint;
//   - `s3-<something>`    — the legacy dash-region form (`s3-eu-west-2`) and
//                           the access-point/object-lambda/control variants
//                           (`s3-accesspoint`, `s3-object-lambda`);
//   - `s3express-<az-id>` — S3 Express One Zone (`s3express-euw2-az1`), which
//                           has no dash straight after `s3` and so is not
//                           reachable by either form above.
//
// What is NOT covered, deliberately: any endpoint label that neither is `s3`
// nor begins `s3-`/`s3express-`, and any partition other than the commercial
// one — `amazonaws.com.cn` (China) and `c2s.ic.gov` fail the suffix check
// earlier, not here. If AWS or the vendor moves the artifact bucket onto a
// shape outside this list, the import fails CLOSED with a clear error rather
// than silently granting the wrong host; recovering needs a code change.
const S3_ENDPOINT_LABEL_RE = /^s3(express)?(-[a-z0-9-]+)?$/;

/**
 * True if `host` (already known to end in `.amazonaws.com`) is S3-shaped: an
 * S3 endpoint label sits in a position an S3 endpoint actually occupies, with
 * at least one bucket label in front of it.
 *
 * Position matters. Asking merely whether SOME label looked like an endpoint
 * let a bucket name carry the whole check —
 * `s3-backups.execute-api.eu-west-1.amazonaws.com` is an API Gateway host and
 * passed. The endpoint label is either the last label before the suffix
 * (`<bucket>.s3.amazonaws.com`) or the one before a single region label
 * (`<bucket>.s3.<region>.amazonaws.com`), and nowhere else.
 *
 * Virtual-hosted style ONLY: index >= 1 requires a bucket label, which is what
 * rejects the path-style endpoints `s3.amazonaws.com` and
 * `s3.<region>.amazonaws.com`. Those hosts are shared by every bucket in the
 * region, so a grant for one is a grant for all of them — far more than the
 * artifact bucket. The marketplace's own presigned urls are virtual-hosted
 * (see the recorded example in CLAUDE.md), so nothing is given up.
 *
 * Without the shape rule at all, a manipulated download url could win a host
 * grant for `sts.amazonaws.com` or any other AWS service, since the only other
 * rule is the `.amazonaws.com` suffix itself.
 *
 * Deliberately NOT mirrored in the manifest: `optional_host_permissions` stays
 * the region-agnostic `https://*.amazonaws.com/*`. Chrome match patterns
 * cannot express a partial subdomain wildcard anyway, and pinning a region
 * there would re-create exactly the silent breakage the hardcoded bucket name
 * caused. The narrowing belongs at request time, here.
 */
function isS3ShapedHost(host: string): boolean {
  const labels = host.slice(0, -S3_HOST_SUFFIX.length).split(".");
  // Last label before the suffix, then the one before a region label. Index
  // must be >= 1: something has to be the bucket.
  for (const index of [labels.length - 1, labels.length - 2]) {
    if (index >= 1 && S3_ENDPOINT_LABEL_RE.test(labels[index]!)) return true;
  }
  return false;
}

/**
 * True only for a concrete, requestable artifact origin: exactly
 * `https://<host>` where `<host>` is a real, S3-shaped hostname ending in
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
  // ...and S3's, not any other AWS service's.
  if (!isS3ShapedHost(host)) return false;

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
  return PCLOUD_ORIGIN_PATTERN_RE.test(pattern) || isS3OriginPattern(pattern);
}
