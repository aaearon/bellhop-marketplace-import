import { describe, it, expect } from "vitest";
import { describeImportFailure } from "../src/import-error.js";

// The 9,725,456-byte artifact this was built against: base64 balloons the
// ~9.27 MiB zip into a ~12.97 MB JSON body, which Privilege Cloud's ASP.NET
// `maxRequestLength` rejects with HTTP 500. See CLAUDE.md "Known
// limitations" for the full measured chain.
const OVERSIZE_BYTES = 9725456;

function oversizeBody(): string {
  return JSON.stringify({
    _message: "Maximum request length exceeded.",
    _exceptionType: "System.Web.HttpException",
  });
}

describe("describeImportFailure", () => {
  it("1. 409 -> the exact current re-import string, no 'Failed:' prefix", () => {
    expect(describeImportFailure(409, "anything, ignored")).toBe(
      "Already imported into this tenant"
    );
    // The 409 branch takes priority regardless of body shape.
    expect(describeImportFailure(409, "")).toBe("Already imported into this tenant");
  });

  it("2. oversize 500 with artifactBytes -> short message including the MB size", () => {
    expect(describeImportFailure(500, oversizeBody(), OVERSIZE_BYTES)).toBe(
      "Failed: too large for Privilege Cloud (9.3 MB) - not an extension limit"
    );
  });

  it("3. oversize 500 without artifactBytes -> same message, no size parenthetical", () => {
    expect(describeImportFailure(500, oversizeBody())).toBe(
      "Failed: too large for Privilege Cloud - not an extension limit"
    );
  });

  it("4. oversize 500 detection is case-insensitive on _message", () => {
    const body = JSON.stringify({
      _message: "MAXIMUM REQUEST LENGTH EXCEEDED.",
      _exceptionType: "System.Web.HttpException",
    });
    expect(describeImportFailure(500, body, OVERSIZE_BYTES)).toBe(
      "Failed: too large for Privilege Cloud (9.3 MB) - not an extension limit"
    );
  });

  it("5. 500 with a DIFFERENT System.Web exception falls through to generic", () => {
    const body = JSON.stringify({
      _message: "Some other server error.",
      _exceptionType: "System.Web.HttpUnhandledException",
    });
    expect(describeImportFailure(500, body, OVERSIZE_BYTES)).toBe(
      "Failed: HTTP 500 - " + body
    );
  });

  it("5b. 500 with the right exceptionType but unrelated _message falls through to generic", () => {
    const body = JSON.stringify({
      _message: "Some unrelated failure.",
      _exceptionType: "System.Web.HttpException",
    });
    expect(describeImportFailure(500, body, OVERSIZE_BYTES)).toBe(
      "Failed: HTTP 500 - " + body
    );
  });

  it("6. 500 with non-JSON body -> generic, never throws", () => {
    expect(describeImportFailure(500, "Internal Server Error")).toBe(
      "Failed: HTTP 500 - Internal Server Error"
    );
  });

  it("7. 500 with a JSON array body -> generic, never throws", () => {
    const body = JSON.stringify(["a", "b"]);
    expect(describeImportFailure(500, body)).toBe("Failed: HTTP 500 - " + body);
  });

  it("8. empty body -> generic with no ' - ' suffix", () => {
    expect(describeImportFailure(500, "")).toBe("Failed: HTTP 500");
  });

  it("9. undefined/null body -> generic, never throws", () => {
    expect(describeImportFailure(500, undefined as unknown as string)).toBe(
      "Failed: HTTP 500"
    );
    expect(describeImportFailure(500, null as unknown as string)).toBe(
      "Failed: HTTP 500"
    );
  });

  it("10. generic 4xx passes status and body through unchanged", () => {
    const body = '{"error":"forbidden"}';
    expect(describeImportFailure(403, body)).toBe("Failed: HTTP 403 - " + body);
  });

  it("11. generic body truncates at exactly 120 chars", () => {
    const body120 = "x".repeat(120);
    expect(describeImportFailure(400, body120)).toBe("Failed: HTTP 400 - " + body120);
  });

  it("12. generic body of 121 chars truncates to the first 120", () => {
    const body121 = "x".repeat(121);
    expect(describeImportFailure(400, body121)).toBe(
      "Failed: HTTP 400 - " + "x".repeat(120)
    );
  });
});
