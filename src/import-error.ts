// Turns an import POST's raw HTTP status/body into the text rendered onto
// the "Import into Privilege Cloud" button label. Pure and defensive: never
// throws, regardless of what `body` contains, because it runs on whatever a
// remote server returned.

/**
 * True if `body` is a JSON object shaped like the ASP.NET
 * `httpRuntime maxRequestLength` rejection Privilege Cloud returns for an
 * over-large import POST, e.g.:
 *
 *   {"_message":"Maximum request length exceeded.","_exceptionType":"System.Web.HttpException"}
 *
 * Any parse failure, non-object shape (including arrays and null), or
 * mismatched field is "not this error" rather than a throw.
 */
function isOversizeRequestError(body: string | null | undefined): boolean {
  if (!body) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return false;
  }

  const obj = parsed as Record<string, unknown>;
  if (obj._exceptionType !== "System.Web.HttpException") return false;
  if (typeof obj._message !== "string") return false;

  return obj._message.toLowerCase().includes("maximum request length exceeded");
}

/** Binary-MB size, e.g. 9,725,456 bytes -> "9.3 MB", matching CLAUDE.md's usage. */
function formatArtifactSizeMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/**
 * Maps an import response to the button-label text.
 *
 * Priority order:
 * 1. HTTP 409 (already imported into this tenant) -> the existing short
 *    statement, unchanged, with no "Failed:" prefix.
 * 2. HTTP 500 whose body is the ASP.NET "Maximum request length exceeded"
 *    exception -> a short, clear message: this is a Privilege Cloud
 *    server-side request-size limit, not an extension bug (see CLAUDE.md
 *    "Known limitations"). Includes the artifact size in MB when known.
 * 3. Anything else -> the existing generic "Failed: HTTP <status>[ - body]"
 *    form, with the body truncated to 120 chars.
 */
export function describeImportFailure(
  status: number,
  body: string | null | undefined,
  artifactBytes?: number
): string {
  if (status === 409) {
    return "Already imported into this tenant";
  }

  if (status === 500 && isOversizeRequestError(body)) {
    const sizeSuffix =
      typeof artifactBytes === "number" && Number.isFinite(artifactBytes)
        ? " (" + formatArtifactSizeMB(artifactBytes) + ")"
        : "";
    return "Failed: too large for Privilege Cloud" + sizeSuffix + " - not an extension limit";
  }

  let reason = status ? "HTTP " + status : "unknown error";
  if (body) {
    reason += " - " + String(body).slice(0, 120);
  }
  return "Failed: " + reason;
}
