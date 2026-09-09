import { describe, it, expect } from "vitest";
import {
  iconFilesFromManifest,
  isRuntimeLibFile,
  expectedLibFileFor,
  deriveRuntimeFileList,
  assertManifestAtRoot,
  assertLibCoversSrc,
} from "../tools/package-lib.mjs";

describe("iconFilesFromManifest", () => {
  it("1. extracts and sorts the icon paths referenced by manifest.icons", () => {
    const manifest = {
      icons: { "128": "icons/icon128.png", "16": "icons/icon16.png", "48": "icons/icon48.png" },
    };
    expect(iconFilesFromManifest(manifest)).toEqual([
      "icons/icon128.png",
      "icons/icon16.png",
      "icons/icon48.png",
    ]);
  });

  it("2. excludes a file present in the icons directory but not referenced by the manifest", () => {
    const manifest = { icons: { "16": "icons/icon16.png" } };
    expect(iconFilesFromManifest(manifest)).toEqual(["icons/icon16.png"]);
  });

  it("3. returns an empty list when icons is missing", () => {
    expect(iconFilesFromManifest({})).toEqual([]);
  });
});

describe("isRuntimeLibFile", () => {
  it("4. accepts a plain compiled .js file", () => {
    expect(isRuntimeLibFile("base64.js")).toBe(true);
  });

  it("5. rejects a source map", () => {
    expect(isRuntimeLibFile("base64.js.map")).toBe(false);
  });

  it("6. rejects a declaration file", () => {
    expect(isRuntimeLibFile("base64.d.ts")).toBe(false);
  });

  it("7. rejects a TypeScript source file", () => {
    expect(isRuntimeLibFile("base64.ts")).toBe(false);
  });

  it("8. rejects a dotfile", () => {
    expect(isRuntimeLibFile(".gitkeep")).toBe(false);
  });
});

describe("expectedLibFileFor", () => {
  it("9. maps a src .ts file to its compiled lib/ counterpart", () => {
    expect(expectedLibFileFor("base64.ts")).toBe("lib/base64.js");
  });

  it("10. returns null for a non-.ts file", () => {
    expect(expectedLibFileFor("base64.js")).toBeNull();
  });

  it("11. returns null for a declaration file", () => {
    expect(expectedLibFileFor("base64.d.ts")).toBeNull();
  });
});

describe("deriveRuntimeFileList", () => {
  it("12. combines fixed files, manifest icons, and filtered lib files", () => {
    const manifest = { icons: { "16": "icons/icon16.png" } };
    const libFiles = ["base64.js", "base64.js.map", "tenant.js"];
    expect(deriveRuntimeFileList({ manifest, libFiles })).toEqual([
      "background.js",
      "content.js",
      "icons/icon16.png",
      "lib/base64.js",
      "lib/tenant.js",
      "manifest.json",
    ]);
  });
});

describe("assertManifestAtRoot", () => {
  it("13. passes when manifest.json is a top-level entry", () => {
    expect(assertManifestAtRoot(["manifest.json", "background.js"]).ok).toBe(true);
  });

  it("14. fails when manifest.json is nested inside a directory", () => {
    const result = assertManifestAtRoot(["extension/manifest.json", "extension/background.js"]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/archive root/);
  });
});

describe("assertLibCoversSrc", () => {
  it("15. passes when every src file has a lib/ counterpart in the zip", () => {
    const result = assertLibCoversSrc(["base64.ts", "tenant.ts"], ["lib/base64.js", "lib/tenant.js"]);
    expect(result).toEqual({ ok: true, missing: [] });
  });

  it("16. reports a missing src file with no lib/ counterpart", () => {
    const result = assertLibCoversSrc(["base64.ts", "version.ts"], ["lib/base64.js"]);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["version.ts"]);
  });
});
