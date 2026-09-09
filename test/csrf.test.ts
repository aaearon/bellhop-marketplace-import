import { describe, it, expect } from "vitest";
import { findXsrfCookie, xsrfCandidateNames } from "../src/csrf.js";

describe("findXsrfCookie", () => {
  it("1. finds an exact guid-suffixed match", () => {
    const cookies = [
      { name: "unrelated", value: "x" },
      { name: "XSRF-TOKEN-3fa85f64-5717-4562-b3fc-2c963f66afa6", value: "secret1" },
    ];
    expect(findXsrfCookie(cookies)).toEqual({
      name: "XSRF-TOKEN-3fa85f64-5717-4562-b3fc-2c963f66afa6",
      value: "secret1",
    });
  });

  it("2. returns null when there is no match", () => {
    const cookies = [
      { name: "session", value: "abc" },
      { name: "other", value: "def" },
    ];
    expect(findXsrfCookie(cookies)).toBeNull();
  });

  it("3. CHANGED: fails closed (null) when multiple valid candidates are present and no targetHost is given, instead of picking the first in array order", () => {
    // Previously this returned the first match. Idira partners are
    // authenticated to multiple tenants at once, so `chrome.cookies.getAll`
    // can legitimately return more than one XSRF-TOKEN-* cookie. Without a
    // targetHost to disambiguate, guessing risks using the wrong tenant's
    // token, so we now fail closed.
    const cookies = [
      { name: "XSRF-TOKEN-11111111-1111-1111-1111-111111111111", value: "first" },
      { name: "XSRF-TOKEN-22222222-2222-2222-2222-222222222222", value: "second" },
    ];
    expect(findXsrfCookie(cookies)).toBeNull();
  });

  it("4. ignores a decoy cookie with an invalid (non-guid) suffix", () => {
    const cookies = [
      { name: "session", value: "abc" },
      { name: "XSRF-TOKEN-something-not-a-guid", value: "decoy" },
      { name: "other", value: "def" },
    ];
    expect(findXsrfCookie(cookies)).toBeNull();
  });

  it("5. does not match a lowercase cookie name (case-sensitive match)", () => {
    const cookies = [
      { name: "xsrf-token-3fa85f64-5717-4562-b3fc-2c963f66afa6", value: "secret" },
    ];
    expect(findXsrfCookie(cookies)).toBeNull();
  });

  it("6. targetHost omitted, single candidate: still returns it (unchanged behaviour)", () => {
    const cookies = [
      { name: "XSRF-TOKEN-3fa85f64-5717-4562-b3fc-2c963f66afa6", value: "secret1" },
    ];
    expect(findXsrfCookie(cookies)).toEqual({
      name: "XSRF-TOKEN-3fa85f64-5717-4562-b3fc-2c963f66afa6",
      value: "secret1",
    });
  });

  it("7. targetHost omitted, several candidates: null (fail closed)", () => {
    const cookies = [
      { name: "XSRF-TOKEN-11111111-1111-1111-1111-111111111111", value: "first" },
      { name: "XSRF-TOKEN-22222222-2222-2222-2222-222222222222", value: "second" },
    ];
    expect(findXsrfCookie(cookies, undefined)).toBeNull();
  });

  it("8. empty array returns null", () => {
    expect(findXsrfCookie([])).toBeNull();
    expect(findXsrfCookie([], "tenant1.cyberark.cloud")).toBeNull();
  });

  it("9. single host-only candidate matching targetHost exactly is returned", () => {
    const cookies = [
      {
        name: "XSRF-TOKEN-11111111-1111-1111-1111-111111111111",
        value: "host-only",
        domain: "tenant1.cyberark.cloud",
      },
    ];
    expect(findXsrfCookie(cookies, "tenant1.cyberark.cloud")).toEqual({
      name: "XSRF-TOKEN-11111111-1111-1111-1111-111111111111",
      value: "host-only",
    });
  });

  it("10. single parent-domain candidate scoped to .cyberark.cloud is returned", () => {
    const cookies = [
      {
        name: "XSRF-TOKEN-11111111-1111-1111-1111-111111111111",
        value: "parent-scope",
        domain: ".cyberark.cloud",
      },
    ];
    expect(findXsrfCookie(cookies, "tenant1.cyberark.cloud")).toEqual({
      name: "XSRF-TOKEN-11111111-1111-1111-1111-111111111111",
      value: "parent-scope",
    });
  });

  it("11. host-only candidate is preferred over a parent-domain candidate for the same target", () => {
    const cookies = [
      {
        name: "XSRF-TOKEN-11111111-1111-1111-1111-111111111111",
        value: "parent-scope",
        domain: ".cyberark.cloud",
      },
      {
        name: "XSRF-TOKEN-22222222-2222-2222-2222-222222222222",
        value: "host-only",
        domain: "tenant1.cyberark.cloud",
      },
    ];
    expect(findXsrfCookie(cookies, "tenant1.cyberark.cloud")).toEqual({
      name: "XSRF-TOKEN-22222222-2222-2222-2222-222222222222",
      value: "host-only",
    });
  });

  it("12. a candidate scoped to an unrelated tenant is excluded entirely, not merely deprioritised", () => {
    const cookies = [
      {
        name: "XSRF-TOKEN-11111111-1111-1111-1111-111111111111",
        value: "wrong-tenant",
        domain: "tenant2.cyberark.cloud",
      },
      {
        name: "XSRF-TOKEN-22222222-2222-2222-2222-222222222222",
        value: "right-tenant",
        domain: "tenant1.cyberark.cloud",
      },
    ];
    expect(findXsrfCookie(cookies, "tenant1.cyberark.cloud")).toEqual({
      name: "XSRF-TOKEN-22222222-2222-2222-2222-222222222222",
      value: "right-tenant",
    });
  });

  it("13. two host-only candidates tied at the same (best) specificity: null (fail closed)", () => {
    const cookies = [
      {
        name: "XSRF-TOKEN-11111111-1111-1111-1111-111111111111",
        value: "a",
        domain: "tenant1.cyberark.cloud",
      },
      {
        name: "XSRF-TOKEN-22222222-2222-2222-2222-222222222222",
        value: "b",
        domain: "tenant1.cyberark.cloud",
      },
    ];
    expect(findXsrfCookie(cookies, "tenant1.cyberark.cloud")).toBeNull();
  });

  it("14. leading-dot and non-dot parent-domain forms are treated equivalently", () => {
    const withDot = [
      {
        name: "XSRF-TOKEN-11111111-1111-1111-1111-111111111111",
        value: "with-dot",
        domain: ".cyberark.cloud",
      },
    ];
    const withoutDot = [
      {
        name: "XSRF-TOKEN-11111111-1111-1111-1111-111111111111",
        value: "without-dot",
        domain: "cyberark.cloud",
      },
    ];
    expect(findXsrfCookie(withDot, "tenant1.cyberark.cloud")).toEqual({
      name: "XSRF-TOKEN-11111111-1111-1111-1111-111111111111",
      value: "with-dot",
    });
    expect(findXsrfCookie(withoutDot, "tenant1.cyberark.cloud")).toEqual({
      name: "XSRF-TOKEN-11111111-1111-1111-1111-111111111111",
      value: "without-dot",
    });
  });

  it("15. a decoy XSRF-TOKEN-not-a-guid candidate is ignored even with targetHost given", () => {
    const cookies = [
      {
        name: "XSRF-TOKEN-not-a-guid",
        value: "decoy",
        domain: "tenant1.cyberark.cloud",
      },
    ];
    expect(findXsrfCookie(cookies, "tenant1.cyberark.cloud")).toBeNull();
  });

  it("16. case sensitivity of the XSRF-TOKEN- prefix is preserved with targetHost given", () => {
    const cookies = [
      {
        name: "xsrf-token-3fa85f64-5717-4562-b3fc-2c963f66afa6",
        value: "secret",
        domain: "tenant1.cyberark.cloud",
      },
    ];
    expect(findXsrfCookie(cookies, "tenant1.cyberark.cloud")).toBeNull();
  });

  it("17. a candidate with a missing domain field is tolerated (no throw) and excluded when targetHost is given", () => {
    const cookies = [
      { name: "XSRF-TOKEN-11111111-1111-1111-1111-111111111111", value: "no-domain" },
      {
        name: "XSRF-TOKEN-22222222-2222-2222-2222-222222222222",
        value: "has-domain",
        domain: "tenant1.cyberark.cloud",
      },
    ];
    expect(() => findXsrfCookie(cookies, "tenant1.cyberark.cloud")).not.toThrow();
    expect(findXsrfCookie(cookies, "tenant1.cyberark.cloud")).toEqual({
      name: "XSRF-TOKEN-22222222-2222-2222-2222-222222222222",
      value: "has-domain",
    });
  });
});

describe("xsrfCandidateNames", () => {
  it("18. returns just the names of all XSRF-TOKEN-* candidates in a mixed cookie jar", () => {
    const cookies = [
      { name: "session", value: "abc" },
      {
        name: "XSRF-TOKEN-11111111-1111-1111-1111-111111111111",
        value: "secret1",
        domain: "tenant1.cyberark.cloud",
      },
      { name: "XSRF-TOKEN-not-a-guid", value: "decoy" },
      {
        name: "XSRF-TOKEN-22222222-2222-2222-2222-222222222222",
        value: "secret2",
        domain: ".cyberark.cloud",
      },
      { name: "xsrf-token-33333333-3333-3333-3333-333333333333", value: "lowercase" },
    ];
    expect(xsrfCandidateNames(cookies)).toEqual([
      "XSRF-TOKEN-11111111-1111-1111-1111-111111111111",
      "XSRF-TOKEN-22222222-2222-2222-2222-222222222222",
    ]);
  });

  it("19. returns an empty array when there are no candidates", () => {
    expect(xsrfCandidateNames([{ name: "session", value: "abc" }])).toEqual([]);
    expect(xsrfCandidateNames([])).toEqual([]);
  });
});
