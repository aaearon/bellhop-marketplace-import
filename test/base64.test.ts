import { describe, it, expect } from "vitest";
import { arrayBufferToBase64 } from "../src/base64.js";

function bytes(arr: number[]): ArrayBuffer {
  return new Uint8Array(arr).buffer;
}

describe("arrayBufferToBase64", () => {
  it("1. empty buffer -> empty string", () => {
    expect(arrayBufferToBase64(bytes([]))).toBe("");
  });

  it("2. 1-byte input -> base64 with == padding", () => {
    expect(arrayBufferToBase64(bytes([0x61]))).toBe("YQ==");
  });

  it("3. 2-byte input -> base64 with = padding", () => {
    expect(arrayBufferToBase64(bytes([0x61, 0x62]))).toBe("YWI=");
  });

  it("4. 3-byte input -> base64 with no padding", () => {
    expect(arrayBufferToBase64(bytes([0x61, 0x62, 0x63]))).toBe("YWJj");
  });

  it("5. known vector: Hello, World!", () => {
    const encoder = new TextEncoder();
    const buf = encoder.encode("Hello, World!").buffer;
    expect(arrayBufferToBase64(buf)).toBe("SGVsbG8sIFdvcmxkIQ==");
  });

  it("6. zip magic header bytes", () => {
    expect(arrayBufferToBase64(bytes([0x50, 0x4b, 0x03, 0x04]))).toBe("UEsDBA==");
  });

  it("7. large buffer (>1MB) does not throw and round-trips exactly", () => {
    const size = 2 * 1024 * 1024 + 7; // 2MB + a bit, deterministic pseudo-random
    const arr = new Uint8Array(size);
    let seed = 12345;
    for (let i = 0; i < size; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      arr[i] = seed & 0xff;
    }
    const buf = arr.buffer;

    let result: string = "";
    expect(() => {
      result = arrayBufferToBase64(buf);
    }).not.toThrow();

    const decoded = atob(result);
    const decodedBytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) {
      decodedBytes[i] = decoded.charCodeAt(i);
    }
    expect(decodedBytes.length).toBe(arr.length);
    expect(decodedBytes).toEqual(arr);
  });
});
