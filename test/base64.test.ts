import { describe, it, expect } from "vitest";
import { arrayBufferToBase64 } from "../src/base64.js";

// Mirrors CHUNK_SIZE in src/base64.ts. Kept in sync by hand so the module
// does not have to export an implementation detail; the boundary cases below
// are only meaningful while this matches.
const CHUNK_SIZE = 32 * 1024;

function bytes(arr: number[]): ArrayBuffer {
  return new Uint8Array(arr).buffer;
}

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Index of the first differing byte, or -1 if the two runs are identical.
 *
 * Deliberately not `expect(a).toEqual(b)`: on a multi-megabyte typed array
 * that deep structural walk cost ~3.8s on its own and is what timed the
 * large-buffer case out on CI's slower CPU. An index compare is ~1500x
 * cheaper and its failure (the offset) is more useful than a truncated
 * two-million-element diff.
 */
function firstMismatch(actual: Uint8Array, expected: Uint8Array): number {
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) return i;
  }
  return -1;
}

/**
 * `Uint8Array` is generic over `ArrayBufferLike` under this TS lib, so
 * `.buffer` widens to include `SharedArrayBuffer`. Every array here is
 * allocated locally by `new Uint8Array(n)`, so the narrowing is sound.
 */
function bufferOf(arr: Uint8Array): ArrayBuffer {
  return arr.buffer as ArrayBuffer;
}

function expectRoundTrip(source: Uint8Array): void {
  const decoded = decodeBase64(arrayBufferToBase64(bufferOf(source)));
  expect(decoded.length).toBe(source.length);
  expect(firstMismatch(decoded, source)).toBe(-1);
}

/** Deterministic pseudo-random bytes, so a failure is reproducible. */
function pseudoRandomBytes(size: number): Uint8Array {
  const arr = new Uint8Array(size);
  let seed = 12345;
  for (let i = 0; i < size; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    arr[i] = seed & 0xff;
  }
  return arr;
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

  it("7. high bytes (0x80-0xFF) survive verbatim", () => {
    // The failure this guards against is an implementation that routes the
    // bytes through a text codec: 0x80-0xFF are not valid standalone UTF-8,
    // so a careless decode replaces each with U+FFFD and silently corrupts
    // the zip. Checked as a known vector, not just a round trip, so a
    // symmetric encode/decode bug cannot cancel itself out.
    expect(arrayBufferToBase64(bytes([0x80, 0xfe, 0xff]))).toBe("gP7/");
    expectRoundTrip(new Uint8Array(Array.from({ length: 256 }, (_, i) => i)));
  });

  it("8. sizes straddling the chunk boundary round-trip exactly", () => {
    // The encoder walks the buffer in CHUNK_SIZE steps, so an off-by-one in
    // the subarray window would only show up at these lengths. CHUNK_SIZE is
    // not a multiple of 3, so these also land mid-base64-triplet.
    for (const size of [
      CHUNK_SIZE - 1,
      CHUNK_SIZE,
      CHUNK_SIZE + 1,
      2 * CHUNK_SIZE - 1,
      2 * CHUNK_SIZE,
      2 * CHUNK_SIZE + 1,
    ]) {
      expectRoundTrip(pseudoRandomBytes(size));
    }
  });

  it("9. large buffer (>1MB) does not throw and round-trips exactly", () => {
    // The point of this case: the naive `String.fromCharCode(...allBytes)`
    // throws RangeError somewhere in the low hundreds of thousands of bytes,
    // so only a multi-megabyte input proves the chunking actually works.
    const arr = pseudoRandomBytes(2 * 1024 * 1024 + 7);

    let result: string = "";
    expect(() => {
      result = arrayBufferToBase64(bufferOf(arr));
    }).not.toThrow();

    const decoded = decodeBase64(result);
    expect(decoded.length).toBe(arr.length);
    expect(firstMismatch(decoded, arr)).toBe(-1);
  });
});
