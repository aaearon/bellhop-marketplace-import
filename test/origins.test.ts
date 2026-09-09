import { describe, it, expect } from "vitest";
import {
  isAllowedOriginPattern,
  isS3OriginPattern,
  isValidS3Origin,
  s3OriginPatternFromDownloadUrl,
  APEX_ORIGIN_PATTERN,
} from "../src/origins.js";

// The artifact origin is NOT hardcoded any more: the vendor bucket is a
// Jenkins-generated name that changes without notice. It is derived at runtime
// from the presigned download url and validated against the rules below before
// chrome.permissions.request() is ever called.

describe("isAllowedOriginPattern (runtime permissions.request allowlist)", () => {
  it("1. accepts an exact per-tenant pcloud pattern", () => {
    expect(isAllowedOriginPattern("https://acme-poc-pcloud.cyberark.cloud/*")).toBe(true);
  });

  it("2. accepts the bare apex pattern", () => {
    expect(isAllowedOriginPattern("https://cyberark.cloud/*")).toBe(true);
    expect(APEX_ORIGIN_PATTERN).toBe("https://cyberark.cloud/*");
  });

  it("3. accepts a valid, concrete S3 origin pattern", () => {
    expect(
      isAllowedOriginPattern("https://some-bucket.s3.eu-west-2.amazonaws.com/*")
    ).toBe(true);
  });

  it("4. REJECTS the wildcard manifest declaration https://*.amazonaws.com/*", () => {
    expect(isAllowedOriginPattern("https://*.amazonaws.com/*")).toBe(false);
  });

  it("5. REJECTS the literal wildcard https://*.cyberark.cloud/* (declaration only, never requested)", () => {
    expect(isAllowedOriginPattern("https://*.cyberark.cloud/*")).toBe(false);
  });

  it("6. REJECTS amazonaws.com lookalike hosts", () => {
    expect(isAllowedOriginPattern("https://evil-amazonaws.com/*")).toBe(false);
    expect(isAllowedOriginPattern("https://amazonaws.com.evil.com/*")).toBe(false);
  });

  it("7. REJECTS non-https schemes", () => {
    expect(isAllowedOriginPattern("http://some-bucket.s3.eu-west-2.amazonaws.com/*")).toBe(false);
    expect(isAllowedOriginPattern("http://cyberark.cloud/*")).toBe(false);
    expect(isAllowedOriginPattern("http://acme-pcloud.cyberark.cloud/*")).toBe(false);
  });

  it("8. REJECTS an S3 host carrying embedded userinfo", () => {
    expect(isAllowedOriginPattern("https://user:pass@bucket.s3.amazonaws.com/*")).toBe(false);
  });

  it("9. REJECTS an S3 host with an explicit port", () => {
    expect(isAllowedOriginPattern("https://bucket.s3.amazonaws.com:8443/*")).toBe(false);
  });

  it("10. REJECTS non-string input and the empty string", () => {
    expect(isAllowedOriginPattern(undefined)).toBe(false);
    expect(isAllowedOriginPattern(null)).toBe(false);
    expect(isAllowedOriginPattern(42)).toBe(false);
    expect(isAllowedOriginPattern("")).toBe(false);
  });

  it("11. REJECTS an all-hosts wildcard and unrelated origins", () => {
    expect(isAllowedOriginPattern("<all_urls>")).toBe(false);
    expect(isAllowedOriginPattern("https://*/*")).toBe(false);
    expect(isAllowedOriginPattern("https://evil.com/*")).toBe(false);
  });
});

describe("isValidS3Origin (concrete artifact origin validator)", () => {
  it("12. accepts a valid, concrete S3 host", () => {
    expect(isValidS3Origin("https://some-bucket.s3.eu-west-2.amazonaws.com")).toBe(true);
    expect(
      isValidS3Origin(
        "https://jenkinsmarketplacemaster-prod-content-eu-west-2.s3.eu-west-2.amazonaws.com"
      )
    ).toBe(true);
  });

  it("13. REJECTS the wildcard form https://*.amazonaws.com", () => {
    expect(isValidS3Origin("https://*.amazonaws.com")).toBe(false);
    expect(isValidS3Origin("https://*.s3.amazonaws.com")).toBe(false);
  });

  it("14. REJECTS the literal wildcard https://*.cyberark.cloud", () => {
    expect(isValidS3Origin("https://*.cyberark.cloud")).toBe(false);
  });

  it("15. REJECTS lookalike hosts", () => {
    expect(isValidS3Origin("https://evil-amazonaws.com")).toBe(false);
    expect(isValidS3Origin("https://amazonaws.com.evil.com")).toBe(false);
    expect(isValidS3Origin("https://amazonaws.com")).toBe(false);
  });

  it("16. REJECTS non-https", () => {
    expect(isValidS3Origin("http://bucket.s3.amazonaws.com")).toBe(false);
    expect(isValidS3Origin("ftp://bucket.s3.amazonaws.com")).toBe(false);
  });

  it("17. REJECTS embedded userinfo", () => {
    expect(isValidS3Origin("https://user:pass@bucket.s3.amazonaws.com")).toBe(false);
    expect(isValidS3Origin("https://user@bucket.s3.amazonaws.com")).toBe(false);
  });

  it("18. REJECTS an explicit port", () => {
    expect(isValidS3Origin("https://bucket.s3.amazonaws.com:443")).toBe(false);
    expect(isValidS3Origin("https://bucket.s3.amazonaws.com:8443")).toBe(false);
  });

  it("19. REJECTS anything that is not a bare origin", () => {
    expect(isValidS3Origin("https://bucket.s3.amazonaws.com/artifact.zip")).toBe(false);
    expect(isValidS3Origin("not a url")).toBe(false);
    expect(isValidS3Origin(undefined)).toBe(false);
  });
});

describe("isS3OriginPattern", () => {
  it("20. accepts a concrete S3 origin in match-pattern form", () => {
    expect(isS3OriginPattern("https://some-bucket.s3.eu-west-2.amazonaws.com/*")).toBe(true);
  });

  it("21. REJECTS a pattern without the /* suffix, and the wildcard host form", () => {
    expect(isS3OriginPattern("https://some-bucket.s3.eu-west-2.amazonaws.com")).toBe(false);
    expect(isS3OriginPattern("https://*.amazonaws.com/*")).toBe(false);
  });
});

describe("s3OriginPatternFromDownloadUrl (runtime derivation)", () => {
  it("22. derives the origin pattern from a presigned download url", () => {
    const url =
      "https://jenkinsmarketplacemaster-prod-content-eu-west-2.s3.eu-west-2.amazonaws.com/" +
      "artifacts/abc.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=600";
    expect(s3OriginPatternFromDownloadUrl(url)).toBe(
      "https://jenkinsmarketplacemaster-prod-content-eu-west-2.s3.eu-west-2.amazonaws.com/*"
    );
  });

  it("23. derives from a differently-named bucket (the bucket name is not hardcoded)", () => {
    expect(
      s3OriginPatternFromDownloadUrl("https://another-bucket.s3.us-east-1.amazonaws.com/x.zip")
    ).toBe("https://another-bucket.s3.us-east-1.amazonaws.com/*");
  });

  it("24. returns null for lookalike, non-https, userinfo, port and wildcard urls", () => {
    expect(s3OriginPatternFromDownloadUrl("https://evil-amazonaws.com/x.zip")).toBeNull();
    expect(s3OriginPatternFromDownloadUrl("https://amazonaws.com.evil.com/x.zip")).toBeNull();
    expect(s3OriginPatternFromDownloadUrl("http://bucket.s3.amazonaws.com/x.zip")).toBeNull();
    expect(
      s3OriginPatternFromDownloadUrl("https://user:pass@bucket.s3.amazonaws.com/x.zip")
    ).toBeNull();
    expect(s3OriginPatternFromDownloadUrl("https://bucket.s3.amazonaws.com:8443/x.zip")).toBeNull();
    expect(s3OriginPatternFromDownloadUrl("https://*.amazonaws.com/x.zip")).toBeNull();
  });

  it("25. returns null for missing/garbage input", () => {
    expect(s3OriginPatternFromDownloadUrl(undefined)).toBeNull();
    expect(s3OriginPatternFromDownloadUrl("")).toBeNull();
    expect(s3OriginPatternFromDownloadUrl("not a url")).toBeNull();
  });

  it("26. the derived pattern is itself accepted by the runtime allowlist", () => {
    const pattern = s3OriginPatternFromDownloadUrl(
      "https://some-bucket.s3.eu-west-2.amazonaws.com/a.zip?sig=1"
    );
    expect(pattern).not.toBeNull();
    expect(isAllowedOriginPattern(pattern as string)).toBe(true);
  });
});
