import { describe, it, expect } from "vitest";
import { deriveOrigins, InvalidTenantUrlError } from "../src/tenant.js";

const expected = {
  tenant: "acme-poc",
  shellOrigin: "https://acme-poc.cyberark.cloud",
  marketplaceOrigin: "https://acme-poc-marketplace.cyberark.cloud",
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

  it("10. derives origins from the marketplace host (content script's actual origin)", () => {
    const result = deriveOrigins(
      "https://acme-poc-marketplace.cyberark.cloud/#/marketplace/product-info/19fa7d61-e550-45a5-88a3-7b2ace0b8f53"
    );
    expect(result).toEqual(expected);
  });

  it("11. does not mangle a tenant whose name contains '-pcloud' mid-string, not as a true suffix", () => {
    // "foo-pcloud-test" ends with "-test", not "-pcloud" -- the env suffix
    // check must be anchored to the true end of the label.
    const result = deriveOrigins("https://foo-pcloud-test.cyberark.cloud/");
    expect(result.tenant).toBe("foo-pcloud-test");
    expect(result.pcloudApiBase).toBe(
      "https://foo-pcloud-test-pcloud.cyberark.cloud/PasswordVault/API"
    );
  });

  it("12. correctly strips the '-pcloud' suffix for the pcloud host of a tenant containing '-pcloud' in its name", () => {
    // The pcloud-environment host for tenant "foo-pcloud-test" is
    // "foo-pcloud-test-pcloud.cyberark.cloud" -- the trailing "-pcloud" here
    // IS the true env suffix and must be stripped, leaving the tenant intact.
    const result = deriveOrigins("https://foo-pcloud-test-pcloud.cyberark.cloud/");
    expect(result.tenant).toBe("foo-pcloud-test");
  });

  it("13. does not mangle a tenant whose name contains '-marketplace' mid-string, not as a true suffix", () => {
    const result = deriveOrigins("https://foo-marketplace-test.cyberark.cloud/");
    expect(result.tenant).toBe("foo-marketplace-test");
  });
});
