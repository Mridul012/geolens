import { describe, expect, it } from "vitest";
import { formatUuidV7, isUuid, uuidV7Timestamp } from "../../../../src/domain/shared/uuid.js";

const entropy = (fill: number): Uint8Array => new Uint8Array(10).fill(fill);

describe("formatUuidV7", () => {
  it("produces a canonical, valid UUID string", () => {
    const id = formatUuidV7(1_700_000_000_000, entropy(0xab));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(isUuid(id)).toBe(true);
  });

  it("sets version 7 and the RFC-4122 variant", () => {
    const id = formatUuidV7(1_700_000_000_000, entropy(0xff));
    expect(id[14]).toBe("7");
    expect(["8", "9", "a", "b"]).toContain(id[19]);
  });

  it("embeds the timestamp so ids sort by creation time", () => {
    const earlier = formatUuidV7(1_700_000_000_000, entropy(0xff));
    const later = formatUuidV7(1_700_000_000_001, entropy(0x00));
    expect(uuidV7Timestamp(earlier)).toBe(1_700_000_000_000);
    expect(earlier < later).toBe(true);
  });

  it("is deterministic for the same inputs", () => {
    expect(formatUuidV7(42, entropy(7))).toBe(formatUuidV7(42, entropy(7)));
  });

  it("rejects a timestamp beyond 48 bits and short entropy", () => {
    expect(() => formatUuidV7(2 ** 48, entropy(1))).toThrow(RangeError);
    expect(() => formatUuidV7(-1, entropy(1))).toThrow(RangeError);
    expect(() => formatUuidV7(1.5, entropy(1))).toThrow(RangeError);
    expect(() => formatUuidV7(1, new Uint8Array(9))).toThrow(RangeError);
  });

  it("handles the epoch and the 48-bit maximum", () => {
    expect(uuidV7Timestamp(formatUuidV7(0, entropy(0)))).toBe(0);
    expect(uuidV7Timestamp(formatUuidV7(0xffff_ffff_ffff, entropy(0)))).toBe(0xffff_ffff_ffff);
  });
});

describe("isUuid", () => {
  it("rejects non-UUID strings", () => {
    expect(isUuid("")).toBe(false);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("00000000-0000-0000-0000-000000000000")).toBe(false); // nil: version 0
    expect(isUuid("6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(true); // v1
  });
});
