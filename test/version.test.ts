import { describe, it, expect } from "vitest";
import { checkVersionSync, validateManifestVersion } from "../src/version.js";

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
