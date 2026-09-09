// Type declarations for package-lib.mjs, needed only so `tsc --noEmit`
// (which reaches test/package-lib.test.ts) can typecheck that import.
// package-lib.mjs itself stays plain JS on purpose, consistent with the
// rest of tools/ and extension/ — see CLAUDE.md "Conventions".

export interface ManifestLike {
  icons?: Record<string, string>;
}

export function iconFilesFromManifest(manifest: ManifestLike | null | undefined): string[];

export function isRuntimeLibFile(filename: unknown): boolean;

export function expectedLibFileFor(srcFileName: unknown): string | null;

export function deriveRuntimeFileList(args: {
  manifest: ManifestLike;
  libFiles: string[];
}): string[];

export function assertManifestAtRoot(zipEntries: string[] | null | undefined): {
  ok: boolean;
  reason: string | null;
};

export function assertLibCoversSrc(
  srcTsFiles: string[] | null | undefined,
  zipEntries: string[] | null | undefined
): { ok: boolean; missing: string[] };
