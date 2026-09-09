// Bellhop - pure helpers for tools/package.mjs, split out so they can be
// unit-tested with vitest (see test/package-lib.test.ts) without touching
// the filesystem or spawning `zip`.

/**
 * Extracts the runtime-relative icon file paths referenced by a manifest's
 * `icons` map, e.g. { "16": "icons/icon16.png" } -> ["icons/icon16.png"].
 * Deduped and sorted. Only what the manifest actually references is
 * included — this is what keeps a non-runtime file (a store-listing
 * preview image, say) out of the package without hardcoding a directory
 * glob.
 */
export function iconFilesFromManifest(manifest) {
  const icons = manifest && typeof manifest === "object" ? manifest.icons : undefined;
  if (!icons || typeof icons !== "object") {
    return [];
  }
  const files = new Set();
  for (const value of Object.values(icons)) {
    if (typeof value === "string" && value.length > 0) {
      files.add(value);
    }
  }
  return [...files].sort();
}

/**
 * True for a compiled output file that belongs in the shipped extension/lib/
 * — plain `.js`, not a source map, declaration file, or TypeScript source.
 * Defensive even though the current tsconfig.build.json already disables
 * source maps and declarations: if that config ever changes, packaging
 * must not silently start shipping them.
 */
export function isRuntimeLibFile(filename) {
  if (typeof filename !== "string") return false;
  if (!filename.endsWith(".js")) return false;
  if (filename.endsWith(".d.ts")) return false;
  if (filename.endsWith(".js.map")) return false;
  if (filename.startsWith(".")) return false;
  return true;
}

/**
 * Maps a src/ TypeScript file name to the compiled lib/ file it must
 * produce, e.g. "base64.ts" -> "lib/base64.js". Returns null for a name
 * that isn't a plain top-level .ts file (e.g. a .test.ts, which src/ does
 * not contain, or a declaration file).
 */
export function expectedLibFileFor(srcFileName) {
  if (typeof srcFileName !== "string") return null;
  if (!srcFileName.endsWith(".ts") || srcFileName.endsWith(".d.ts")) return null;
  const base = srcFileName.slice(0, -3);
  return `lib/${base}.js`;
}

/**
 * Combines the fixed top-level runtime files, the manifest-derived icon
 * files, and the already-filtered lib/ files into the full, sorted list of
 * paths (relative to extension/) to place in the package zip.
 */
export function deriveRuntimeFileList({ manifest, libFiles }) {
  const fixed = ["manifest.json", "background.js", "content.js"];
  const icons = iconFilesFromManifest(manifest);
  const lib = (libFiles || []).filter(isRuntimeLibFile).map((f) => `lib/${f}`);
  return [...new Set([...fixed, ...icons, ...lib])].sort();
}

/**
 * Checks that "manifest.json" is present as a top-level zip entry (not
 * nested inside a directory such as "extension/manifest.json") — Chrome
 * silently rejects an upload where the extension is nested one level down.
 */
export function assertManifestAtRoot(zipEntries) {
  const hasRootManifest = (zipEntries || []).includes("manifest.json");
  return {
    ok: hasRootManifest,
    reason: hasRootManifest
      ? null
      : `"manifest.json" is not present at the archive root. Entries: ${JSON.stringify(zipEntries)}`,
  };
}

/**
 * Checks that every src/*.ts file has a corresponding lib/*.js entry in the
 * zip. Returns the list of src files with no counterpart (empty when OK).
 */
export function assertLibCoversSrc(srcTsFiles, zipEntries) {
  const entrySet = new Set(zipEntries || []);
  const missing = [];
  for (const srcFile of srcTsFiles || []) {
    const expected = expectedLibFileFor(srcFile);
    if (expected && !entrySet.has(expected)) {
      missing.push(srcFile);
    }
  }
  return { ok: missing.length === 0, missing };
}
