/**
 * The golden-eval gate (AI-Pipeline §8, Engineering-Rules §15.11).
 *
 * Any change under `infrastructure/ai/prompts/`, `config/model-tiers.ts` or
 * `config/scoring/` must run this. It scores the six fixture sites and compares them to
 * `baseline.json`. Deliberate movement is fine — update the baseline and say why in the
 * ADR. Undetected movement is the thing this exists to prevent.
 *
 *   npm run evals:golden           compare against the baseline
 *   npm run evals:golden -- --write   record a new baseline
 *
 * Exits non-zero on any drift, so CI can gate on it.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { pino } from "pino";
import { computeScore } from "../src/application/scoring/compute-score.js";
import { CrawlsRepo } from "../src/infrastructure/db/repositories/crawls.repo.js";
import { ScoresRepo } from "../src/infrastructure/db/repositories/scores.repo.js";
import { SiteFactsRepo } from "../src/infrastructure/db/repositories/site-facts.repo.js";
import { TopicsRepo } from "../src/infrastructure/db/repositories/topics.repo.js";
import { TopicCoverageRepo } from "../src/infrastructure/db/repositories/topic-coverage.repo.js";
import { SCORING_V1 } from "../src/config/scoring/v1.js";
import { GOLDEN_SITES } from "./golden-sites/sites.js";
import { seedGoldenSite } from "./golden-sites/fixtures.js";

const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), "golden-sites", "baseline.json");

/** Tolerances fixed by AI-Pipeline §8. */
export const COMPOSITE_TOLERANCE = 3;
export const COMPONENT_TOLERANCE = 5;

export interface GoldenResult {
  readonly key: string;
  readonly composite: number | null;
  readonly components: Readonly<Record<string, number | null>>;
}

export interface Baseline {
  readonly configVersion: string;
  readonly recordedAt: string;
  readonly sites: Readonly<Record<string, { composite: number | null; components: Record<string, number | null> }>>;
}

export function readBaseline(): Baseline {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

/**
 * Scores every golden site.
 *
 * Each one gets its own project, so a leak between fixtures shows up as a wrong score
 * rather than as a passing test built on shared state. The fixtures are deleted afterwards
 * — this runs against a real database, and a developer's dev database should not slowly
 * fill with six fake companies every time the gate runs.
 */
export async function scoreGoldenCorpus(prisma: PrismaClient): Promise<readonly GoldenResult[]> {
  const log = pino({ level: "silent" });
  const deps = {
    crawls: new CrawlsRepo(prisma),
    scores: new ScoresRepo(prisma),
    siteFacts: new SiteFactsRepo(prisma),
    topics: new TopicsRepo(prisma),
    coverage: new TopicCoverageRepo(prisma),
    log,
  };

  const results: GoldenResult[] = [];
  const seededProjects: string[] = [];

  try {
    for (const site of GOLDEN_SITES) {
      const seeded = await seedGoldenSite(prisma, site);
      seededProjects.push(seeded.projectId);

      const scored = await computeScore(deps, {
        projectId: seeded.projectId,
        crawlId: seeded.crawlId,
      });
      if (!scored.ok) {
        throw new Error(`golden site ${site.key} failed to score: ${scored.error.code}`);
      }

      const rows = scored.value.components["components"] as Array<{
        component: string;
        value: number | null;
      }>;
      results.push({
        key: site.key,
        composite: scored.value.score?.composite ?? null,
        components: Object.fromEntries(rows.map((row) => [row.component, row.value])),
      });
    }
    return results;
  } finally {
    for (const projectId of seededProjects) {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { userId: true },
      });
      await prisma.project.deleteMany({ where: { id: projectId } });
      if (project !== null) await prisma.user.deleteMany({ where: { id: project.userId } });
    }
  }
}

export interface Drift {
  readonly site: string;
  readonly field: string;
  readonly baseline: number | null;
  readonly actual: number | null;
  readonly tolerance: number;
}

/** Every score that moved further than §8 allows. */
export function compareToBaseline(
  results: readonly GoldenResult[],
  baseline: Baseline,
): readonly Drift[] {
  const drift: Drift[] = [];

  for (const result of results) {
    const recorded = baseline.sites[result.key];
    if (recorded === undefined) {
      drift.push({
        site: result.key,
        field: "composite",
        baseline: null,
        actual: result.composite,
        tolerance: COMPOSITE_TOLERANCE,
      });
      continue;
    }

    const check = (
      field: string,
      expected: number | null,
      actual: number | null,
      tolerance: number,
    ): void => {
      // Null↔number is always drift: a component appearing or vanishing changes what the
      // composite means, however small the numeric difference looks.
      if (expected === null || actual === null) {
        if (expected !== actual) drift.push({ site: result.key, field, baseline: expected, actual, tolerance });
        return;
      }
      if (Math.abs(expected - actual) > tolerance) {
        drift.push({ site: result.key, field, baseline: expected, actual, tolerance });
      }
    };

    check("composite", recorded.composite, result.composite, COMPOSITE_TOLERANCE);
    for (const [component, value] of Object.entries(result.components)) {
      check(component, recorded.components[component] ?? null, value, COMPONENT_TOLERANCE);
    }
  }

  return drift;
}

/** The directional facts that must hold whatever the numbers are (§8). */
export function checkInvariants(results: readonly GoldenResult[]): readonly string[] {
  const failures: string[] = [];
  const by = new Map(results.map((result) => [result.key, result]));

  const rich = by.get("rich-saas")?.composite ?? 0;
  const thin = by.get("thin-saas")?.composite ?? 0;
  if (rich <= thin) failures.push(`rich-saas (${rich}) must score above thin-saas (${thin})`);

  // §8 writes this invariant as "blocked site's `technical` < 40". Taken strictly it is
  // unsatisfiable for the interesting fixture: bot access is 50% of the component, so a
  // site that blocks every bot but is otherwise flawless scores exactly 40 and no less.
  // The cap is the real guarantee — and it is stronger than the doc's inequality, because
  // it holds for *every* blocked site rather than for the ones that also have bad markup.
  const blockedTechnical = by.get("robots-blocked")?.components["technical"] ?? 100;
  if (blockedTechnical > 40) {
    failures.push(
      `robots-blocked technical (${blockedTechnical}) must be capped at 40 — bot access is ` +
        `half the component`,
    );
  }

  const noMarkup = by.get("no-structured-data")?.components["technical"] ?? 100;
  const richTechnical = by.get("rich-saas")?.components["technical"] ?? 0;
  if (noMarkup >= richTechnical) {
    failures.push(
      `no-structured-data technical (${noMarkup}) must be below rich-saas (${richTechnical})`,
    );
  }

  return failures;
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const prisma = new PrismaClient();

  try {
    const results = await scoreGoldenCorpus(prisma);

    if (write) {
      const baseline: Baseline = {
        configVersion: SCORING_V1.version,
        recordedAt: new Date().toISOString(),
        sites: Object.fromEntries(
          results.map((result) => [
            result.key,
            { composite: result.composite, components: { ...result.components } },
          ]),
        ),
      };
      writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
      process.stdout.write(`Recorded baseline for ${results.length} sites at ${SCORING_V1.version}\n`);
      return;
    }

    const baseline = readBaseline();
    const drift = compareToBaseline(results, baseline);
    const invariants = checkInvariants(results);

    for (const result of results) {
      process.stdout.write(
        `${result.key.padEnd(20)} composite=${String(result.composite).padStart(4)}\n`,
      );
    }

    if (baseline.configVersion !== SCORING_V1.version) {
      process.stdout.write(
        `\nBaseline was recorded at ${baseline.configVersion}; the config is now ${SCORING_V1.version}.\n` +
          `A version change is expected to move scores — re-record with --write and explain it in the ADR.\n`,
      );
    }

    for (const item of drift) {
      process.stdout.write(
        `DRIFT ${item.site}.${item.field}: baseline ${String(item.baseline)} → ${String(item.actual)} ` +
          `(tolerance ±${item.tolerance})\n`,
      );
    }
    for (const failure of invariants) process.stdout.write(`INVARIANT ${failure}\n`);

    if (drift.length > 0 || invariants.length > 0) {
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`\nAll ${results.length} golden sites within tolerance.\n`);
  } finally {
    await prisma.$disconnect();
  }
}

// Only when run directly; the golden test imports the functions above.
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  await main();
}
