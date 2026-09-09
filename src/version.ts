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
