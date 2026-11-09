/**
 * The golden-eval gate, run as part of the suite (M12 acceptance; AI-Pipeline §8).
 *
 * `npm run evals:golden` is the CI gate a prompt or weight change must pass. Running the
 * same corpus here means the baseline cannot rot quietly between deliberate runs of the
 * gate — a weight edited without a baseline update fails the ordinary test suite too.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  checkInvariants,
  compareToBaseline,
  readBaseline,
  scoreGoldenCorpus,
  COMPOSITE_TOLERANCE,
} from "../../../evals/run-golden.js";
import { GOLDEN_SITES } from "../../../evals/golden-sites/sites.js";
import { SCORING_V1 } from "../../../src/config/scoring/v1.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;

beforeAll(() => {
  prisma = createTestPrisma();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await truncateAll(prisma);
});

describe("the golden corpus", () => {
  it("scores every site within tolerance of the recorded baseline", async () => {
    const baseline = readBaseline();
    const results = await scoreGoldenCorpus(prisma);

    expect(results).toHaveLength(GOLDEN_SITES.length);
    // A weight change without a baseline update fails here, by design.
    expect(compareToBaseline(results, baseline)).toEqual([]);
  });

  it("holds the directional invariants whatever the numbers are", async () => {
    expect(checkInvariants(await scoreGoldenCorpus(prisma))).toEqual([]);
  });

  it("is reproducible — the corpus scores identically on a second run", async () => {
    const first = await scoreGoldenCorpus(prisma);
    await truncateAll(prisma);
    const second = await scoreGoldenCorpus(prisma);

    expect(second.map((row) => row.composite)).toEqual(first.map((row) => row.composite));
  });

  it("has a baseline recorded at the config version in force", async () => {
    // A mismatch means the baseline predates a scoring change and must be re-recorded with
    // an ADR explaining the movement, rather than silently accepted.
    expect(readBaseline().configVersion).toBe(SCORING_V1.version);
  });

  it("separates a rich site from a thin one by more than the drift tolerance", async () => {
    const results = await scoreGoldenCorpus(prisma);
    const rich = results.find((row) => row.key === "rich-saas")?.composite ?? 0;
    const thin = results.find((row) => row.key === "thin-saas")?.composite ?? 0;

    // If the gap were within the tolerance, the baseline could not tell them apart and the
    // whole corpus would be measuring noise.
    expect(rich - thin).toBeGreaterThan(COMPOSITE_TOLERANCE * 3);
  });
});
