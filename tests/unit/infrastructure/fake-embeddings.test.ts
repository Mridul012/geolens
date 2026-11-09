/**
 * The fake adapter's embeddings — the function the whole product runs on with no API keys.
 *
 * These tests pin the properties other code is allowed to rely on: determinism, unit
 * length, correct *ordering*. They deliberately do not pin absolute similarity values,
 * because the adapter is a hashing bag-of-words function and its cosines are not on a real
 * sentence embedder's scale. Anything that needs a calibrated threshold uses the
 * controlled `SubjectAdapter` instead.
 */
import { describe, expect, it } from "vitest";
import { FakeAdapter } from "../../../src/infrastructure/ai/adapters/fake.adapter.js";
import { cosineSimilarity } from "../../../src/domain/topics/coverage.js";

const adapter = new FakeAdapter();

async function embed(...inputs: string[]): Promise<number[][]> {
  const result = await adapter.embed({ model: "fake", inputs, timeoutMs: 1_000 });
  return result.vectors.map((vector) => [...vector]);
}

describe("shape", () => {
  it("returns one unit vector of the model's dimension per input", async () => {
    const [vector] = await embed("anything at all");
    expect(vector).toHaveLength(1_536);
    const magnitude = Math.sqrt((vector ?? []).reduce((sum, value) => sum + value * value, 0));
    expect(magnitude).toBeCloseTo(1, 10);
  });

  it("is deterministic across calls and across instances", async () => {
    const [first] = await embed("pricing and plans");
    const second = (
      await new FakeAdapter().embed({
        model: "fake",
        inputs: ["pricing and plans"],
        timeoutMs: 1_000,
      })
    ).vectors[0];
    expect(first).toEqual([...(second ?? [])]);
  });

  it("returns a valid vector for text with no content words", async () => {
    const [vector] = await embed("the and of to");
    const magnitude = Math.sqrt((vector ?? []).reduce((sum, value) => sum + value * value, 0));
    expect(magnitude).toBeCloseTo(1, 10);
  });

  it("returns nothing for no inputs", async () => {
    expect(await embed()).toEqual([]);
  });
});

describe("ordering", () => {
  it("scores identical text at 1", async () => {
    const [a, b] = await embed("enterprise pricing", "enterprise pricing");
    expect(cosineSimilarity(a as number[], b as number[])).toBeCloseTo(1, 10);
  });

  it("places related prose far above unrelated prose", async () => {
    const [topic, related, unrelated] = await embed(
      "Pricing and plans. What the product costs and how the plans compare.",
      "Our pricing is simple. The Starter plan costs ten dollars per month and the Growth plan costs fifty.",
      "We are SOC 2 Type II certified and complete an annual penetration test with an auditor.",
    );

    const near = cosineSimilarity(topic as number[], related as number[]);
    const far = cosineSimilarity(topic as number[], unrelated as number[]);
    expect(near).toBeGreaterThan(0.5);
    expect(far).toBeLessThan(0.1);
    expect(near).toBeGreaterThan(far * 5);
  });

  it("ignores stopwords, so two unrelated sentences are not similar for saying 'the'", async () => {
    const [a, b] = await embed(
      "The invoice is in the post and it is with you by the weekend.",
      "The kettle is on the counter and it is by the window that we have.",
    );
    expect(cosineSimilarity(a as number[], b as number[])).toBeLessThan(0.2);
  });

  it("collapses simple inflections, so plural and singular are the same term", async () => {
    const [singular, plural] = await embed("pricing plan", "pricing plans");
    expect(cosineSimilarity(singular as number[], plural as number[])).toBeCloseTo(1, 10);
  });

  it("partially aligns morphological variants a suffix stripper cannot reach", async () => {
    // "encrypted"/"encryption" and "migrate"/"migration" share a prefix gram, not a stem.
    const [a, b] = await embed("data is encrypted", "data encryption");
    const [c, d] = await embed("migrate your data", "data migration");
    expect(cosineSimilarity(a as number[], b as number[])).toBeGreaterThan(0.4);
    expect(cosineSimilarity(c as number[], d as number[])).toBeGreaterThan(0.3);
  });

  it("does not make unrelated words similar just because they share a prefix", async () => {
    const [a, b] = await embed("planetarium telescope", "pricing plan");
    expect(cosineSimilarity(a as number[], b as number[])).toBeLessThan(0.35);
  });
});
