import { describe, it, expect } from "vitest";
import { deriveOrigins, InvalidTenantUrlError } from "../src/tenant.js";

const expected = {
  tenant: "acme-poc",
  shellOrigin: "https://acme-poc.cyberark.cloud",
  marketplaceOrigin: "https://acme-poc-managespace.cyberark.cloud",
  pcloudOrigin: "https://acme-poc-pcloud.cyberark.cloud",
  pcloudApiBase: "https://acme-poc-pcloud.cyberark.cloud/PasswordVault/API",
};

describe("deriveOrigins", () => {
  it("1. derives origins from the shell host", () => {
    expect(deriveOrigins("https://acme-poc.cyberark.cloud/")).toEqual(expected);
  });

  it("2. derives origins from the marketplace host", () => {
    expect(deriveOrigins("https://acme-poc-managespace.cyberark.cloud/")).toEqual(expected);
  });

  it("3. derives origins from the pcloud host with a path", () => {
    expect(deriveOrigins("https://acme-poc-pcloud.cyberark.cloud/PasswordVault/")).toEqual(expected);
  });

  it("4. preserves a hyphenated tenant name exactly (does not truncate at first hyphen)", () => {
    const r1 = deriveOrigins("https://acme-poc.cyberark.cloud/");
    const r2 = deriveOrigins("https://acme-poc-managespace.cyberark.cloud/");
    const r3 = deriveOrigins("https://acme-poc-pcloud.cyberark.cloud/");
    expect(r1.tenant).toBe("acme-poc");
    expect(r2.tenant).toBe("acme-poc");
    expect(r3.tenant).toBe("acme-poc");
  });

  it("5. accepts both http and https schemes", () => {
    expect(deriveOrigins("http://acme-poc.cyberark.cloud/").tenant).toBe("acme-poc");
    expect(deriveOrigins("https://acme-poc.cyberark.cloud/").tenant).toBe("acme-poc");
  });

  it("6. ignores path, query string, and fragment", () => {
    const result = deriveOrigins(
      "https://acme-poc.cyberark.cloud/some/path?query=1&x=2#fragment"
    );
    expect(result).toEqual(expected);
  });

  it("7. rejects a non-cyberark.cloud host", () => {
    expect(() => deriveOrigins("https://example.com/")).toThrow(InvalidTenantUrlError);
  });

  it("8. rejects a lookalike host (suffix-matching attack)", () => {
    expect(() => deriveOrigins("https://cyberark.cloud.evil.com/")).toThrow(InvalidTenantUrlError);
  });

  it("9. rejects a bare host with no tenant segment", () => {
    expect(() => deriveOrigins("https://cyberark.cloud/")).toThrow(InvalidTenantUrlError);
  });
});
