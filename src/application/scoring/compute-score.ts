/**
 * The scoring engine — **the only place a `scores` row is ever written** (golden rule #2).
 *
 * Everything upstream produces evidence; this is where evidence becomes the number the
 * product is named for. Three properties make that defensible:
 *
 * 1. **It computes nothing itself.** Retrievability, coverage and content quality were
 *    measured by their own components and are read back here. Technical and trust are
 *    deterministic sums over observed facts. No model output is ever *a* score
 *    (AI-Pipeline §6.4).
 * 2. **It is reproducible.** Same crawl, same config version, same number — the composite
 *    is a pure function and everything variable was fixed before it ran.
 * 3. **It refuses to publish a weak number.** Below half the total weight there is no row
 *    at all, and the dashboard says "score pending". A wrong score is worse than no score.
 */
import {
  ACTIVE_SCORING_CONFIG,
  DECISION_INTENT_MULTIPLIER,
  QUALITY_SAMPLE,
  TECHNICAL_WEIGHTS_V1,
  TRUST_WEIGHTS_V1,
} from "../../config/scoring/v1.js";
import { MIN_CONTENT_WORDS } from "../../config/scoring/content.js";
import {
  contentQualityScore,
  technicalScore,
  topicCoverageScore,
  trustScore,
} from "../../domain/scoring/components.js";
import {
  computeComposite,
  toComponentColumns,
  toComponentsPayload,
  type ComponentInput,
  type ComponentInputs,
} from "../../domain/scoring/composite.js";
import type { Score } from "../../contracts/api/scores.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { notFound } from "../../domain/shared/app-error.js";
import type { JobLogger } from "../ports/job-context.port.js";
import type { CrawlsRepo } from "../../infrastructure/db/repositories/crawls.repo.js";
import type { ScoresRepo } from "../../infrastructure/db/repositories/scores.repo.js";
import type { SiteFactsRepo } from "../../infrastructure/db/repositories/site-facts.repo.js";
import type { TopicCoverageRepo } from "../../infrastructure/db/repositories/topic-coverage.repo.js";
import type { TopicsRepo } from "../../infrastructure/db/repositories/topics.repo.js";

export interface ComputeScoreDeps {
  readonly crawls: CrawlsRepo;
  readonly scores: ScoresRepo;
  readonly siteFacts: SiteFactsRepo;
  readonly topics: TopicsRepo;
  readonly coverage: TopicCoverageRepo;
  readonly log: JobLogger;
}

export interface ComputeScoreInput {
  readonly projectId: string;
  readonly crawlId: string;
}

export interface ComputeScoreResult {
  /** Null when the publication floor was not met — "score pending", not a number. */
  readonly score: Score | null;
  readonly totalWeight: number;
  readonly published: boolean;
  readonly components: Record<string, unknown>;
}

/** Reads a `{ available, … }` analysis block, distinguishing "not yet" from "failed". */
function fromArtifact(
  artifact: Record<string, unknown>,
  key: string,
  value: (block: Record<string, unknown>) => number | null,
): ComponentInput {
  const block = artifact[key];
  if (typeof block !== "object" || block === null) {
    // The stage never ran. On a first crawl that is ordinary, not degradation.
    return { value: null, reason: "unavailable_yet" };
  }

  const record = block as Record<string, unknown>;
  if (record["available"] === false) {
    return {
      value: null,
      reason: "failed",
      evidence: { reason: record["reason"] ?? "unavailable" },
    };
  }

  const score = value(record);
  return score === null
    ? { value: null, reason: "failed", evidence: { reason: "no_value" } }
    : { value: score, evidence: record };
}

export async function computeScore(
  deps: ComputeScoreDeps,
  input: ComputeScoreInput,
): Promise<Result<ComputeScoreResult, AppError>> {
  const crawl = await deps.crawls.findInProject(input.projectId, input.crawlId);
  if (crawl === null) return err(notFound("Crawl"));

  const artifact = (await deps.crawls.findAnalysis(input.projectId, input.crawlId)) ?? {};

  // ── Retrievability (M11) ──────────────────────────────────────────────────
  const retrievability = fromArtifact(artifact, "retrievability", (block) => {
    const score = block["score"];
    return typeof score === "number" ? score : null;
  });

  // ── Topic coverage (M10), weighted 2x for decision-stage topics ───────────
  const activeTopics = await deps.topics.listForProject(input.projectId, "ACTIVE");
  const coverageRows = await deps.coverage.listForCrawl(input.crawlId);
  const byTopic = new Map(coverageRows.map((row) => [row.topicId, row]));
  const coverageEntries = activeTopics.flatMap((topic) => {
    const row = byTopic.get(topic.id);
    return row === undefined
      ? []
      : [{ coverageScore: row.coverageScore, buyerIntent: topic.buyerIntent }];
  });

  const coverageValue = topicCoverageScore(coverageEntries, DECISION_INTENT_MULTIPLIER);
  const coverageBlock = artifact["topicCoverage"];
  const coverageAttempted =
    typeof coverageBlock === "object" && coverageBlock !== null;
  const topicCoverage: ComponentInput =
    coverageValue === null
      ? {
          value: null,
          reason: coverageAttempted ? "failed" : "unavailable_yet",
          ...(coverageAttempted ? { evidence: coverageBlock as Record<string, unknown> } : {}),
        }
      : {
          value: coverageValue,
          evidence: {
            topicsScored: coverageEntries.length,
            decisionTopics: coverageEntries.filter((entry) => entry.buyerIntent === "decision")
              .length,
            crawlId: input.crawlId,
          },
        };

  // ── Content quality (M12) ─────────────────────────────────────────────────
  const pageScores = await deps.crawls.qualityScores(input.crawlId);
  const candidates = await deps.crawls.listQualityCandidates(input.crawlId);
  const sampled = Math.min(QUALITY_SAMPLE.maxPages, candidates.length);
  const quality = contentQualityScore(pageScores, sampled, QUALITY_SAMPLE.minScoredShare);
  const contentQuality: ComponentInput =
    quality.score === null
      ? {
          value: null,
          reason: sampled === 0 ? "unavailable_yet" : "failed",
          evidence: { pagesScored: quality.pagesScored, pagesSampled: quality.pagesSampled },
        }
      : {
          value: quality.score,
          evidence: {
            pagesScored: quality.pagesScored,
            pagesSampled: quality.pagesSampled,
            crawlId: input.crawlId,
          },
        };

  // ── Technical and trust — deterministic, so they never degrade ────────────
  const accessCheck = (artifact["accessCheck"] as Record<string, unknown> | undefined) ?? {};
  const discovery = (artifact["discovery"] as Record<string, unknown> | undefined) ?? {};
  const llmsTxt = (accessCheck["llmsTxt"] as Record<string, unknown> | undefined) ?? {};

  const technicalFacts = await deps.siteFacts.technicalFacts(input.crawlId);
  const technical = technicalScore(
    {
      ...technicalFacts,
      botAccessShare:
        typeof accessCheck["allowedShare"] === "number" ? accessCheck["allowedShare"] : 0,
      llmsTxtPresent: llmsTxt["present"] === true,
      llmsTxtValid: typeof llmsTxt["valid"] === "boolean" ? llmsTxt["valid"] : null,
      sitemapPresent: discovery["sitemapPresent"] === true,
    },
    TECHNICAL_WEIGHTS_V1,
  );

  const trustFacts = await deps.siteFacts.trustFacts(input.crawlId, MIN_CONTENT_WORDS);
  const trust = trustScore(trustFacts, TRUST_WEIGHTS_V1);

  // ── Citation (M15) — absent until a prompt run exists ─────────────────────
  const citation: ComponentInput = { value: null, reason: "unavailable_yet" };

  const inputs: ComponentInputs = {
    citation,
    retrievability,
    contentQuality,
    topicCoverage,
    technical: { value: technical.score, evidence: { parts: technical.parts, ...technicalFacts } },
    trust: { value: trust.score, evidence: { parts: trust.parts, ...trustFacts } },
  };

  const result = computeComposite(inputs, ACTIVE_SCORING_CONFIG);
  const componentsPayload = toComponentsPayload(result);

  if (!result.published || result.composite === null) {
    deps.log.warn(
      { crawlId: input.crawlId, totalWeight: result.totalWeight },
      "publication floor not met; no score written",
    );
    return ok({
      score: null,
      totalWeight: result.totalWeight,
      published: false,
      components: componentsPayload,
    });
  }

  const columns = toComponentColumns(result);
  const score = await deps.scores.insert({
    projectId: input.projectId,
    crawlId: input.crawlId,
    promptRunId: null,
    composite: result.composite,
    citation: columns.citation,
    retrievability: columns.retrievability,
    contentQuality: columns.contentQuality,
    topicCoverage: columns.topicCoverage,
    technical: columns.technical,
    trust: columns.trust,
    components: componentsPayload,
    scoringConfigVersion: result.configVersion,
  });

  deps.log.info(
    {
      crawlId: input.crawlId,
      composite: result.composite,
      totalWeight: result.totalWeight,
      configVersion: result.configVersion,
    },
    "score written",
  );

  return ok({
    score,
    totalWeight: result.totalWeight,
    published: true,
    components: componentsPayload,
  });
}
