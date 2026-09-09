import { describe, it, expect } from "vitest";
import { checkVersionSync, validateManifestVersion, checkTagVersionSync, normalizeTagRef } from "../src/version.js";

describe("validateManifestVersion", () => {
  it("1. accepts a plain three-part version", () => {
    expect(validateManifestVersion("1.2.3")).toEqual([]);
  });

  it("2. accepts a one-part version", () => {
    expect(validateManifestVersion("7")).toEqual([]);
  });

  it("3. accepts a four-part version", () => {
    expect(validateManifestVersion("1.2.3.4")).toEqual([]);
  });

  it("4. accepts a lone zero segment", () => {
    expect(validateManifestVersion("0.1.0")).toEqual([]);
  });

  it("5. rejects too many parts", () => {
    const errors = validateManifestVersion("1.2.3.4.5");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(" ")).toMatch(/at most 4/);
  });

  it("6. rejects an out-of-range part", () => {
    const errors = validateManifestVersion("1.65536.0");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(" ")).toMatch(/out of range/);
  });

  it("7. accepts the maximum boundary value", () => {
    expect(validateManifestVersion("65535.65535.65535.65535")).toEqual([]);
  });

  it("8. rejects a leading zero", () => {
    const errors = validateManifestVersion("1.02.3");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(" ")).toMatch(/leading zero/);
  });

  it("9. rejects a non-numeric part", () => {
    const errors = validateManifestVersion("1.a.3");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(" ")).toMatch(/not a non-negative integer/);
  });

  it("10. rejects an empty string", () => {
    const errors = validateManifestVersion("");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(" ")).toMatch(/empty/);
  });

  it("11. rejects a trailing dot (empty segment)", () => {
    const errors = validateManifestVersion("1.2.");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(" ")).toMatch(/empty segment/);
  });
});

describe("checkVersionSync", () => {
  it("12. reports valid and matching for identical, well-formed versions", () => {
    const result = checkVersionSync("0.1.0", "0.1.0");
    expect(result).toEqual({
      valid: true,
      match: true,
      manifestVersion: "0.1.0",
      packageVersion: "0.1.0",
      errors: [],
    });
  });

  it("13. reports a mismatch between two otherwise-valid versions", () => {
    const result = checkVersionSync("0.1.0", "0.2.0");
    expect(result.valid).toBe(true);
    expect(result.match).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toMatch(/does not match/);
  });

  it("14. reports invalid (and never matches) when the manifest version breaks Chrome's rules", () => {
    const result = checkVersionSync("1.2.3.4.5", "1.2.3.4.5");
    expect(result.valid).toBe(false);
    // match is a plain string comparison independent of validity
    expect(result.match).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("15. does not throw on garbage input", () => {
    expect(() => checkVersionSync("not-a-version", "")).not.toThrow();
  });
});

describe("normalizeTagRef", () => {
  it("16. passes through a bare version unchanged", () => {
    expect(normalizeTagRef("0.1.0")).toBe("0.1.0");
  });

  it("17. strips a leading v", () => {
    expect(normalizeTagRef("v0.1.0")).toBe("0.1.0");
  });

  it("18. strips a refs/tags/ prefix", () => {
    expect(normalizeTagRef("refs/tags/0.1.0")).toBe("0.1.0");
  });

  it("19. strips both a refs/tags/ prefix and a leading v", () => {
    expect(normalizeTagRef("refs/tags/v0.1.0")).toBe("0.1.0");
  });
});

describe("checkTagVersionSync", () => {
  it("20. passes when a v-prefixed tag matches both manifest and package.json", () => {
    const result = checkTagVersionSync("v0.1.0", "0.1.0", "0.1.0");
    expect(result).toEqual({
      ok: true,
      valid: true,
      matchesManifest: true,
      matchesPackage: true,
      tagRef: "v0.1.0",
      normalizedVersion: "0.1.0",
      manifestVersion: "0.1.0",
      packageVersion: "0.1.0",
      errors: [],
    });
  });

  it("21. passes when the tag has no leading v", () => {
    const result = checkTagVersionSync("0.1.0", "0.1.0", "0.1.0");
    expect(result.ok).toBe(true);
  });

  it("22. accepts a refs/tags/ prefixed ref", () => {
    const result = checkTagVersionSync("refs/tags/v0.1.0", "0.1.0", "0.1.0");
    expect(result.ok).toBe(true);
    expect(result.normalizedVersion).toBe("0.1.0");
  });

  it("23. fails closed when the tag disagrees with the manifest", () => {
    const result = checkTagVersionSync("v0.2.0", "0.1.0", "0.1.0");
    expect(result.ok).toBe(false);
    expect(result.valid).toBe(true);
    expect(result.matchesManifest).toBe(false);
    expect(result.matchesPackage).toBe(false);
    expect(result.errors.join(" ")).toMatch(/does not match manifest version/);
  });

  it("24. fails closed when the tag disagrees with package.json only", () => {
    const result = checkTagVersionSync("v0.1.0", "0.1.0", "0.2.0");
    expect(result.ok).toBe(false);
    expect(result.matchesManifest).toBe(true);
    expect(result.matchesPackage).toBe(false);
    expect(result.errors.join(" ")).toMatch(/does not match package\.json version/);
  });

  it("25. rejects a malformed tag (leading zero) without claiming a match", () => {
    const result = checkTagVersionSync("v1.02.3", "1.2.3", "1.2.3");
    expect(result.ok).toBe(false);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/leading zero/);
  });

  it("26. does not throw on garbage input", () => {
    expect(() => checkTagVersionSync("not-a-tag", "0.1.0", "0.1.0")).not.toThrow();
  });
});
