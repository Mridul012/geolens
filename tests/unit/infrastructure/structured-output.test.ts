/**
 * Structured-output handling (Engineering-Rules §6): never parse leniently, exactly one
 * repair retry, then a typed failure. These are the fixtures the rule describes —
 * valid, repairable, and unrepairable.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  describeIssues,
  extractJson,
  repairPrompt,
  validateAgainst,
} from "../../../src/infrastructure/ai/structured/parse.js";

const schema = z.object({ name: z.string(), count: z.number().int().min(1) });

describe("extractJson", () => {
  it("parses a bare object", () => {
    expect(extractJson('{"a":1}')).toEqual({ value: { a: 1 }, unwrapped: false });
  });

  it("unwraps a ```json fence", () => {
    const result = extractJson('```json\n{"a":1}\n```');
    expect(result).toEqual({ value: { a: 1 }, unwrapped: true });
  });

  it("unwraps a bare ``` fence", () => {
    expect(extractJson('```\n{"a":1}\n```')?.value).toEqual({ a: 1 });
  });

  it("finds an object buried in prose", () => {
    const result = extractJson('Sure! Here is the JSON:\n{"a":1}\nHope that helps.');
    expect(result).toEqual({ value: { a: 1 }, unwrapped: true });
  });

  it("handles an array at the top level", () => {
    expect(extractJson("[1,2,3]")?.value).toEqual([1, 2, 3]);
  });

  it("is not confused by braces inside strings", () => {
    const result = extractJson('{"text":"a } brace and a \\" quote","n":1}');
    expect(result?.value).toEqual({ text: 'a } brace and a " quote', n: 1 });
  });

  it("takes the outermost object when nested", () => {
    expect(extractJson('prose {"outer":{"inner":1}} more')?.value).toEqual({
      outer: { inner: 1 },
    });
  });

  it("returns null for text with no JSON at all", () => {
    expect(extractJson("I cannot help with that request.")).toBeNull();
    expect(extractJson("")).toBeNull();
    expect(extractJson("   ")).toBeNull();
  });

  it("returns null for an unterminated object rather than guessing", () => {
    expect(extractJson('{"a":1')).toBeNull();
  });
});

describe("validateAgainst", () => {
  it("accepts valid output", () => {
    const outcome = validateAgainst('{"name":"acme","count":3}', schema);
    expect(outcome).toMatchObject({ ok: true, value: { name: "acme", count: 3 } });
  });

  it("accepts valid output that needed unwrapping, and says so", () => {
    const outcome = validateAgainst('```json\n{"name":"acme","count":3}\n```', schema);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.unwrapped).toBe(true);
  });

  it("reports unparseable output distinctly from invalid output", () => {
    const unparseable = validateAgainst("no json here", schema);
    expect(unparseable).toMatchObject({ ok: false, reason: "unparseable" });

    const invalid = validateAgainst('{"name":"acme"}', schema);
    expect(invalid).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("never coerces a wrong type into a right one", () => {
    // "3" is not 3. Lenient parsing here would put a string in a numeric column.
    const outcome = validateAgainst('{"name":"acme","count":"3"}', schema);
    expect(outcome.ok).toBe(false);
  });

  it("rejects a value outside its declared range", () => {
    expect(validateAgainst('{"name":"acme","count":0}', schema).ok).toBe(false);
  });

  it("names the offending field, so the repair prompt can be specific", () => {
    const outcome = validateAgainst('{"name":"acme"}', schema);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.detail).toContain("count");
  });
});

describe("describeIssues", () => {
  it("renders zod issues as a short list", () => {
    const error = schema.safeParse({ count: -1 });
    expect(error.success).toBe(false);
    if (error.success) return;
    const described = describeIssues(error.error);
    expect(described).toContain("name");
    expect(described).toContain("count");
  });

  it("caps the list so a wildly wrong output cannot balloon the repair prompt", () => {
    const wide = z.object(
      Object.fromEntries(Array.from({ length: 40 }, (_u, i) => [`f${i}`, z.string()])),
    );
    const parsed = wide.safeParse({});
    if (parsed.success) return;
    expect(describeIssues(parsed.error).split("\n")).toHaveLength(10);
  });
});

describe("repairPrompt", () => {
  it("names the problem and asks for JSON only", () => {
    const prompt = repairPrompt('{"name":"acme"}', "- count: Required");
    expect(prompt).toContain("did not match the required schema");
    expect(prompt).toContain("count: Required");
    expect(prompt).toContain("JSON object only");
  });

  it("truncates a huge previous output rather than resending it whole", () => {
    const prompt = repairPrompt("x".repeat(20_000), "- broken");
    expect(prompt.length).toBeLessThan(5_000);
  });
});
