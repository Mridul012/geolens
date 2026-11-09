/**
 * UUIDv7 formatting — pure.
 *
 * The schema generates domain ids app-side as UUIDv7 (docs/Database.md §1.1) so that
 * B-tree inserts stay right-leaning instead of splattering across the index; it matters
 * most for `page_snapshots`, the fastest-growing table.
 *
 * Randomness and the clock are arguments rather than ambient state, which keeps this
 * function deterministic and testable (Engineering-Rules §2.2: domain/ is pure and sync).
 */

const HEX = "0123456789abcdef";

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += HEX[(byte >>> 4) & 0x0f];
    out += HEX[byte & 0x0f];
  }
  return out;
}

/**
 * Lays out a UUIDv7: 48-bit big-endian millisecond timestamp, 4-bit version, 12 bits of
 * randomness, 2-bit variant, 62 bits of randomness.
 *
 * @param timestampMs Unix epoch milliseconds; must fit in 48 bits.
 * @param random 10 bytes of entropy — the caller owns the randomness source.
 */
export function formatUuidV7(timestampMs: number, random: Uint8Array): string {
  if (!Number.isInteger(timestampMs) || timestampMs < 0 || timestampMs > 0xffff_ffff_ffff) {
    throw new RangeError(`timestampMs out of 48-bit range: ${timestampMs}`);
  }
  if (random.length < 10) {
    throw new RangeError(`UUIDv7 needs 10 random bytes, received ${random.length}`);
  }

  const bytes = new Uint8Array(16);
  // 48-bit timestamp, most significant byte first.
  bytes[0] = Math.floor(timestampMs / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(timestampMs / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(timestampMs / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(timestampMs / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(timestampMs / 2 ** 8) & 0xff;
  bytes[5] = timestampMs & 0xff;
  for (let i = 0; i < 10; i += 1) {
    bytes[6 + i] = random[i] as number;
  }
  // Version 7 in the high nibble of byte 6; RFC-4122 variant in the top bits of byte 8.
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;

  const hex = toHex(bytes);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True for any RFC-4122 UUID of version 1–8. */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Reads the embedded millisecond timestamp back out of a UUIDv7. */
export function uuidV7Timestamp(uuid: string): number {
  const hex = uuid.replaceAll("-", "").slice(0, 12);
  return Number.parseInt(hex, 16);
}
