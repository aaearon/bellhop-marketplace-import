import { describe, it, expect } from "vitest";
import { classifyProduct, importPathFor } from "../src/classify.js";

describe("classifyProduct", () => {
  it("1. real PSM connection component payload (Oracle SQL Developer) -> connection-component", () => {
    const detail = {
      hasArtifact: true,
      idiraServices: ["PRIVILEGE_ACCESS_MANAGER_SELF_HOSTED", "PRIVILEGE_CLOUD", "PSM"],
    };
    expect(classifyProduct(detail)).toBe("connection-component");
  });

  it("2. real platform payload (AWS Root Management with MFA) -> platform", () => {
    const detail = {
      hasArtifact: true,
      idiraServices: ["CPM", "PRIVILEGE_ACCESS_MANAGER_SELF_HOSTED", "PRIVILEGE_CLOUD", "SRS"],
    };
    expect(classifyProduct(detail)).toBe("platform");
  });

  it("3. ambiguous: idiraServices contains both a PSM marker and a CPM marker -> null (fail closed)", () => {
    const detail = {
      hasArtifact: true,
      idiraServices: ["PSM", "CPM"],
    };
    expect(classifyProduct(detail)).toBeNull();
  });

  it("4. ambiguous: idiraServices contains both a PSM marker and an SRS marker -> null (fail closed)", () => {
    const detail = {
      hasArtifact: true,
      idiraServices: ["PSM", "SRS"],
    };
    expect(classifyProduct(detail)).toBeNull();
  });

  it("5. hasArtifact: false -> null", () => {
    const detail = {
      hasArtifact: false,
      idiraServices: ["PSM"],
    };
    expect(classifyProduct(detail)).toBeNull();
  });

  it("6. missing idiraServices -> null", () => {
    const detail = {
      hasArtifact: true,
    };
    expect(classifyProduct(detail)).toBeNull();
  });

  it("7. idiraServices present but not an array (string) -> null", () => {
    const detail = {
      hasArtifact: true,
      idiraServices: "PSM",
    };
    expect(classifyProduct(detail)).toBeNull();
  });

  it("8. idiraServices present but not an array (object) -> null", () => {
    const detail = {
      hasArtifact: true,
      idiraServices: { 0: "PSM" },
    };
    expect(classifyProduct(detail)).toBeNull();
  });

  it("9. input is null -> null", () => {
    expect(classifyProduct(null)).toBeNull();
  });

  it("10. input is undefined -> null", () => {
    expect(classifyProduct(undefined)).toBeNull();
  });

  it("11. input is a non-object (number) -> null", () => {
    expect(classifyProduct(42)).toBeNull();
  });

  it("12. input is a non-object (string) -> null", () => {
    expect(classifyProduct("PSM")).toBeNull();
  });

  it("13. unrelated/irrelevant services list with hasArtifact true -> null", () => {
    const detail = {
      hasArtifact: true,
      idiraServices: ["PRIVILEGE_ACCESS_MANAGER_SELF_HOSTED", "PRIVILEGE_CLOUD"],
    };
    expect(classifyProduct(detail)).toBeNull();
  });
});

describe("importPathFor", () => {
  it("1. connection-component -> /ConnectionComponents/Import", () => {
    expect(importPathFor("connection-component")).toBe("/ConnectionComponents/Import");
  });

  it("2. platform -> /Platforms/Import", () => {
    expect(importPathFor("platform")).toBe("/Platforms/Import");
  });
});
