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

  it("3. fails closed (null) when multiple valid candidates are present, instead of picking the first in array order", () => {
    // Idira partners can be authenticated to multiple tenants at once, so
    // more than one XSRF-TOKEN-* candidate can legitimately be present at
    // once. `document.cookie` carries no domain/scope info to disambiguate
    // by, so guessing risks using the wrong tenant's token — fail closed.
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

  it("6. single candidate with no other cookies present: returns it", () => {
    const cookies = [
      { name: "XSRF-TOKEN-3fa85f64-5717-4562-b3fc-2c963f66afa6", value: "secret1" },
    ];
    expect(findXsrfCookie(cookies)).toEqual({
      name: "XSRF-TOKEN-3fa85f64-5717-4562-b3fc-2c963f66afa6",
      value: "secret1",
    });
  });

  it("7. empty array returns null", () => {
    expect(findXsrfCookie([])).toBeNull();
  });
});

describe("xsrfCandidateNames", () => {
  it("8. returns just the names of all XSRF-TOKEN-* candidates in a mixed cookie jar", () => {
    const cookies = [
      { name: "session", value: "abc" },
      { name: "XSRF-TOKEN-11111111-1111-1111-1111-111111111111", value: "secret1" },
      { name: "XSRF-TOKEN-not-a-guid", value: "decoy" },
      { name: "XSRF-TOKEN-22222222-2222-2222-2222-222222222222", value: "secret2" },
      { name: "xsrf-token-33333333-3333-3333-3333-333333333333", value: "lowercase" },
    ];
    expect(xsrfCandidateNames(cookies)).toEqual([
      "XSRF-TOKEN-11111111-1111-1111-1111-111111111111",
      "XSRF-TOKEN-22222222-2222-2222-2222-222222222222",
    ]);
  });

  it("9. returns an empty array when there are no candidates", () => {
    expect(xsrfCandidateNames([{ name: "session", value: "abc" }])).toEqual([]);
    expect(xsrfCandidateNames([])).toEqual([]);
  });
});
