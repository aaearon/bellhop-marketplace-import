// Bellhop - version sync check (pure functions, unit-tested).
//
// `extension/manifest.json` and `package.json` both carry a version string
// with nothing keeping them in sync. Chrome's manifest `version` key has its
// own grammar (Chrome extension docs, "version" key):
//   - 1 to 4 dot-separated integers
//   - each integer 0-65535
//   - no leading zeros (a lone "0" is fine; "01" is not)
// This validates a manifest version against that grammar and compares it
// against another version string (package.json's) for an exact match.

const MAX_VERSION_PART = 65535;
const MAX_VERSION_SEGMENTS = 4;

export interface VersionCheckResult {
  /** True iff manifestVersion satisfies Chrome's manifest `version` grammar. */
  valid: boolean;
  /** True iff manifestVersion and packageVersion are exactly equal strings. */
  match: boolean;
  manifestVersion: string;
  packageVersion: string;
  /** Human-readable reasons for an invalid manifest version or a mismatch. Empty when both hold. */
  errors: string[];
}

/**
 * Validates a version string against Chrome's manifest `version` key rules:
 * 1-4 dot-separated integers, each 0-65535, no leading zeros. Never throws;
 * returns the list of reasons the version is invalid (empty when valid).
 */
export function validateManifestVersion(version: string): string[] {
  const errors: string[] = [];

  if (version.length === 0) {
    errors.push("version is empty");
    return errors;
  }

  const parts = version.split(".");

  if (parts.length > MAX_VERSION_SEGMENTS) {
    errors.push(
      `expected at most ${MAX_VERSION_SEGMENTS} dot-separated integers, got ${parts.length} ("${version}")`
    );
  }

  for (const part of parts) {
    if (part.length === 0) {
      errors.push(`empty segment in version "${version}"`);
      continue;
    }
    if (!/^[0-9]+$/.test(part)) {
      errors.push(`segment "${part}" is not a non-negative integer`);
      continue;
    }
    if (part.length > 1 && part.startsWith("0")) {
      errors.push(`segment "${part}" has a leading zero`);
      continue;
    }
    const n = Number(part);
    if (n > MAX_VERSION_PART) {
      errors.push(`segment "${part}" is out of range (max ${MAX_VERSION_PART})`);
    }
  }

  return errors;
}

/**
 * Compares two version strings and validates the manifest one against
 * Chrome's grammar. Structured result, never throws.
 */
export function checkVersionSync(manifestVersion: string, packageVersion: string): VersionCheckResult {
  const errors = validateManifestVersion(manifestVersion);
  const valid = errors.length === 0;
  const match = manifestVersion === packageVersion;

  if (valid && !match) {
    errors.push(
      `manifest version "${manifestVersion}" does not match package.json version "${packageVersion}"`
    );
  }

  return { valid, match, manifestVersion, packageVersion, errors };
}

export interface TagVersionCheckResult {
  /** True iff every check below passed: convenience AND of the three booleans. */
  ok: boolean;
  /** True iff the normalized tag version satisfies Chrome's manifest `version` grammar. */
  valid: boolean;
  /** True iff the normalized tag version equals manifestVersion. */
  matchesManifest: boolean;
  /** True iff the normalized tag version equals packageVersion. */
  matchesPackage: boolean;
  /** The raw input, e.g. "refs/tags/v0.2.0". */
  tagRef: string;
  /** tagRef with an optional "refs/tags/" prefix and a leading "v" stripped. */
  normalizedVersion: string;
  manifestVersion: string;
  packageVersion: string;
  /** Human-readable reasons for any failure above. Empty iff ok. */
  errors: string[];
}

const REFS_TAGS_PREFIX = "refs/tags/";

/**
 * Normalizes a git tag ref to a bare version string: strips an optional
 * "refs/tags/" prefix (as seen in a raw ref, e.g. from `git ls-remote`) and
 * then an optional leading "v" (the project's tagging convention, e.g.
 * "v0.2.0"). Pure string manipulation — does not validate the result against
 * the version grammar; use validateManifestVersion for that. Never throws.
 */
export function normalizeTagRef(tagRef: string): string {
  let version = tagRef;
  if (version.startsWith(REFS_TAGS_PREFIX)) {
    version = version.slice(REFS_TAGS_PREFIX.length);
  }
  if (version.startsWith("v")) {
    version = version.slice(1);
  }
  return version;
}

/**
 * Checks a git tag ref against both existing sources of truth
 * (manifest.json and package.json). Reuses normalizeTagRef to strip the tag
 * decoration and validateManifestVersion for the grammar check, the same
 * grammar a manifest version must satisfy — a release tag names the same
 * kind of version. Structured result, never throws.
 */
export function checkTagVersionSync(
  tagRef: string,
  manifestVersion: string,
  packageVersion: string
): TagVersionCheckResult {
  const normalizedVersion = normalizeTagRef(tagRef);
  const errors = validateManifestVersion(normalizedVersion);
  const valid = errors.length === 0;
  const matchesManifest = normalizedVersion === manifestVersion;
  const matchesPackage = normalizedVersion === packageVersion;

  if (valid && !matchesManifest) {
    errors.push(
      `tag version "${normalizedVersion}" (from "${tagRef}") does not match manifest version "${manifestVersion}"`
    );
  }
  if (valid && !matchesPackage) {
    errors.push(
      `tag version "${normalizedVersion}" (from "${tagRef}") does not match package.json version "${packageVersion}"`
    );
  }

  return {
    ok: valid && matchesManifest && matchesPackage,
    valid,
    matchesManifest,
    matchesPackage,
    tagRef,
    normalizedVersion,
    manifestVersion,
    packageVersion,
    errors,
  };
}
