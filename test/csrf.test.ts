import { describe, it, expect } from "vitest";
import { findXsrfCookie } from "../src/csrf.js";

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

  it("3. picks the first match in array order when multiple valid cookies are present (documented tie-break rule)", () => {
    const cookies = [
      { name: "XSRF-TOKEN-11111111-1111-1111-1111-111111111111", value: "first" },
      { name: "XSRF-TOKEN-22222222-2222-2222-2222-222222222222", value: "second" },
    ];
    expect(findXsrfCookie(cookies)).toEqual({
      name: "XSRF-TOKEN-11111111-1111-1111-1111-111111111111",
      value: "first",
    });
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
});
