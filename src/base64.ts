// Chunk size chosen well below the JS engine's max call-stack/argument-count
// limits for String.fromCharCode(...spread). 32KB is a conservative, common
// choice for this pattern.
const CHUNK_SIZE = 32 * 1024;

/**
 * Converts an ArrayBuffer to a base64 string.
 *
 * Naive `btoa(String.fromCharCode(...new Uint8Array(buf)))` spreads every
 * byte as an individual function argument, which throws `RangeError:
 * Maximum call stack size exceeded` on large (multi-megabyte) buffers.
 * This builds the binary string incrementally in fixed-size chunks to
 * avoid that limit, then base64-encodes the whole string once.
 */
export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, offset + CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}
