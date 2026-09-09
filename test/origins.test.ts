import { describe, it, expect } from "vitest";
import {
  isAllowedOriginPattern,
  isS3OriginPattern,
  isValidS3Origin,
  s3OriginPatternFromDownloadUrl,
} from "../src/origins.js";

// The artifact origin is NOT hardcoded any more: the vendor bucket is a
// Jenkins-generated name that changes without notice. It is derived at runtime
// from the presigned download url and validated against the rules below before
// chrome.permissions.request() is ever called.

describe("isAllowedOriginPattern (runtime permissions.request allowlist)", () => {
  it("1. accepts an exact per-tenant pcloud pattern", () => {
    expect(isAllowedOriginPattern("https://acme-poc-pcloud.cyberark.cloud/*")).toBe(true);
  });

  // CHANGED: the apex was only ever needed so chrome.cookies could read the
  // parent-domain-scoped XSRF-TOKEN cookie. The token is not HttpOnly, so the
  // content script reads it from document.cookie with no host permission at
  // all, and the apex grant (and the `cookies` permission with it) is gone.
  it("2. CHANGED: REJECTS the bare apex pattern, which is no longer requested", () => {
    expect(isAllowedOriginPattern("https://cyberark.cloud/*")).toBe(false);
    expect(isAllowedOriginPattern("https://cyberark.cloud")).toBe(false);
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

// F4: the validator used to accept ANY concrete *.amazonaws.com host, so a
// manipulated download url could win a grant for sts.amazonaws.com, an
// execute-api endpoint, or anything else AWS hosts. A requestable artifact
// origin must now also be S3-shaped. This is a VALIDATOR change only — the
// manifest declaration stays the region-agnostic `https://*.amazonaws.com/*`,
// because pinning a region there would re-create exactly the silent breakage
// the hardcoded bucket name caused.
describe("isValidS3Origin (S3-shaped host requirement)", () => {
  it("27. accepts virtual-hosted style with a region label", () => {
    expect(isValidS3Origin("https://bucket.s3.eu-west-2.amazonaws.com")).toBe(true);
    expect(isValidS3Origin("https://bucket.s3.us-east-1.amazonaws.com")).toBe(true);
  });

  it("28. accepts virtual-hosted style with no region label", () => {
    expect(isValidS3Origin("https://bucket.s3.amazonaws.com")).toBe(true);
  });

  it("29. accepts the legacy dash-region form", () => {
    expect(isValidS3Origin("https://bucket.s3-eu-west-2.amazonaws.com")).toBe(true);
    expect(isValidS3Origin("https://bucket.s3-us-west-1.amazonaws.com")).toBe(true);
  });

  // CHANGED: path-style used to be accepted. A path-style endpoint host is
  // shared by EVERY bucket in that region, so granting it hands the extension
  // far more than the artifact bucket. The marketplace's own recorded url is
  // virtual-hosted (`jenkinsmarketplacemaster-prod-content-eu-west-2.s3.
  // eu-west-2.amazonaws.com`), so nothing is lost by requiring a bucket label.
  it("30. CHANGED: REJECTS path-style S3 endpoints, which cover every bucket in the region", () => {
    expect(isValidS3Origin("https://s3.amazonaws.com")).toBe(false);
    expect(isValidS3Origin("https://s3.eu-west-2.amazonaws.com")).toBe(false);
    expect(isValidS3Origin("https://s3-eu-west-2.amazonaws.com")).toBe(false);
  });

  it("31. accepts a dotted bucket name in front of the s3 label", () => {
    expect(isValidS3Origin("https://my.dotted.bucket.s3.eu-west-2.amazonaws.com")).toBe(true);
  });

  it("32. REJECTS other AWS services on amazonaws.com", () => {
    expect(isValidS3Origin("https://sts.amazonaws.com")).toBe(false);
    expect(isValidS3Origin("https://abc123.execute-api.eu-west-1.amazonaws.com")).toBe(false);
    expect(isValidS3Origin("https://lambda.eu-west-1.amazonaws.com")).toBe(false);
    expect(isValidS3Origin("https://ec2.eu-west-2.amazonaws.com")).toBe(false);
    expect(isValidS3Origin("https://queue.amazonaws.com")).toBe(false);
  });

  it("33. REJECTS a host whose label merely starts with the letters s3", () => {
    expect(isValidS3Origin("https://s3cret.amazonaws.com")).toBe(false);
    expect(isValidS3Origin("https://bucket.s3x.amazonaws.com")).toBe(false);
    expect(isValidS3Origin("https://bucket.s3-.amazonaws.com")).toBe(false);
  });

  it("34. REJECTS an s3 label that is part of the bucket name only, with no S3 endpoint label", () => {
    // "s3" appearing inside a longer label is not an S3 endpoint marker.
    expect(isValidS3Origin("https://my-s3-backups.amazonaws.com")).toBe(false);
  });

  it("35. the S3-shape rule does not weaken any existing rejection", () => {
    expect(isValidS3Origin("https://bucket.s3.evil.com")).toBe(false);
    expect(isValidS3Origin("https://bucket.s3.amazonaws.com.evil.com")).toBe(false);
    expect(isValidS3Origin("https://bucket.s3-evil-amazonaws.com")).toBe(false);
    expect(isValidS3Origin("http://bucket.s3.amazonaws.com")).toBe(false);
    expect(isValidS3Origin("https://user:pass@bucket.s3.amazonaws.com")).toBe(false);
    expect(isValidS3Origin("https://bucket.s3.amazonaws.com:8443")).toBe(false);
    expect(isValidS3Origin("https://bucket.s3.amazonaws.com/x.zip")).toBe(false);
    expect(isValidS3Origin("https://*.s3.amazonaws.com")).toBe(false);
  });

  it("36. the non-S3 rejection carries through the pattern and derivation helpers", () => {
    expect(isS3OriginPattern("https://sts.amazonaws.com/*")).toBe(false);
    expect(isAllowedOriginPattern("https://sts.amazonaws.com/*")).toBe(false);
    expect(s3OriginPatternFromDownloadUrl("https://sts.amazonaws.com/x.zip")).toBeNull();
    expect(
      s3OriginPatternFromDownloadUrl("https://abc.execute-api.eu-west-1.amazonaws.com/x.zip")
    ).toBeNull();
  });
});

// The S3-shape check used to ask only whether SOME label ahead of the suffix
// looked like an S3 endpoint, at any depth. That let a bucket-name label carry
// the whole check: `s3-backups.execute-api.eu-west-1.amazonaws.com` is an API
// Gateway host and passed. The endpoint label must sit where an S3 endpoint
// actually sits — last before the suffix, or one before a region label — with
// at least one bucket label in front of it.
describe("isValidS3Origin (S3 endpoint label must be in an S3 endpoint position)", () => {
  it("37. REJECTS an S3-looking label sitting in the bucket position of another service", () => {
    expect(isValidS3Origin("https://s3-backups.execute-api.eu-west-1.amazonaws.com")).toBe(false);
    expect(isValidS3Origin("https://s3.execute-api.eu-west-1.amazonaws.com")).toBe(false);
    expect(isValidS3Origin("https://my-s3.lambda.eu-west-1.amazonaws.com")).toBe(false);
  });

  it("38. REJECTS an S3 label buried too deep to be the endpoint", () => {
    expect(isValidS3Origin("https://bucket.s3.something.else.amazonaws.com")).toBe(false);
    expect(isValidS3Origin("https://bucket.s3-eu-west-2.extra.label.amazonaws.com")).toBe(false);
  });

  it("39. still accepts every virtual-hosted form the marketplace can serve", () => {
    expect(isValidS3Origin("https://bucket.s3.amazonaws.com")).toBe(true);
    expect(isValidS3Origin("https://bucket.s3.eu-west-2.amazonaws.com")).toBe(true);
    expect(isValidS3Origin("https://bucket.s3-eu-west-2.amazonaws.com")).toBe(true);
    expect(isValidS3Origin("https://my.dotted.bucket.s3.eu-west-2.amazonaws.com")).toBe(true);
    // Access point / object-lambda endpoints keep the region label after the
    // endpoint label, so they sit in the same position as `s3`.
    expect(
      isValidS3Origin("https://ap-123456789012.s3-accesspoint.eu-west-2.amazonaws.com")
    ).toBe(true);
  });

  // S3 Express One Zone: the endpoint label is `s3express-<az-id>`, with no
  // dash straight after `s3`, so the old label regex missed it entirely.
  it("40. accepts the S3 Express One Zone endpoint form", () => {
    expect(
      isValidS3Origin("https://bucket--euw2-az1--x-s3.s3express-euw2-az1.eu-west-2.amazonaws.com")
    ).toBe(true);
  });

  it("41. the position rule does not weaken any existing rejection", () => {
    expect(isValidS3Origin("https://s3cret.amazonaws.com")).toBe(false);
    expect(isValidS3Origin("https://bucket.s3x.amazonaws.com")).toBe(false);
    expect(isValidS3Origin("https://bucket.s3express.evil.com")).toBe(false);
    expect(isValidS3Origin("https://*.s3.eu-west-2.amazonaws.com")).toBe(false);
  });

  it("42. the position rule carries through the pattern and derivation helpers", () => {
    expect(isS3OriginPattern("https://s3-backups.execute-api.eu-west-1.amazonaws.com/*")).toBe(
      false
    );
    expect(isAllowedOriginPattern("https://s3.eu-west-2.amazonaws.com/*")).toBe(false);
    expect(
      s3OriginPatternFromDownloadUrl("https://s3.eu-west-2.amazonaws.com/some-bucket/x.zip")
    ).toBeNull();
    expect(
      s3OriginPatternFromDownloadUrl(
        "https://s3-backups.execute-api.eu-west-1.amazonaws.com/x.zip"
      )
    ).toBeNull();
  });
});
