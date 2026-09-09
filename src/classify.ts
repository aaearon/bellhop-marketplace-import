export type ProductKind = "connection-component" | "platform";

// idiraServices markers that identify each package kind. The marketplace
// API has no explicit package-type field; this is the reliable discriminator
// confirmed from live data (see CLAUDE.md).
const PSM_MARKER = "PSM";
const PLATFORM_MARKERS = ["CPM", "SRS"];

/**
 * Classifies a marketplace product detail payload into an importable kind.
 *
 * Fails closed (returns null) on: no artifact, a missing/non-array
 * idiraServices, no recognized marker, or an ambiguous payload that matches
 * both a connection-component marker (PSM) and a platform marker (CPM/SRS)
 * at once -- the latter has not been observed in real data but would likely
 * be a bundled package needing two imports in some order, which is out of
 * scope here.
 */
export function classifyProduct(detail: unknown): ProductKind | null {
  if (detail === null || typeof detail !== "object") return null;

  const record = detail as Record<string, unknown>;
  if (record.hasArtifact !== true) return null;
  if (!Array.isArray(record.idiraServices)) return null;

  const services: unknown[] = record.idiraServices;
  const isConnectionComponent = services.indexOf(PSM_MARKER) !== -1;
  const isPlatform = services.some((s) => PLATFORM_MARKERS.indexOf(s as string) !== -1);

  if (isConnectionComponent && isPlatform) {
    console.log(
      "[classify] ambiguous product: idiraServices contains both a PSM marker and a CPM/SRS marker; failing closed.",
      services
    );
    return null;
  }
  if (isConnectionComponent) return "connection-component";
  if (isPlatform) return "platform";
  return null;
}

export function importPathFor(kind: ProductKind): string {
  return kind === "connection-component" ? "/ConnectionComponents/Import" : "/Platforms/Import";
}
