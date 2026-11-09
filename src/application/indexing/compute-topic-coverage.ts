/**
 * Topic coverage for one crawl (AI-Pipeline §3.4).
 *
 * No model call: the taxonomy already has centroids and the corpus already has vectors, so
 * this is arithmetic over what M9 and the index children produced. That is why it is cheap
 * enough to run on every crawl, and why it cannot "fail" the way an LLM step can — the
 * only ways out are *no taxonomy* and *no vectors*, and both are reported as unavailable
 * rather than as a score of zero.
 *
 * The distinction matters more than it looks: a topic scoring 0 means the site says
 * nothing about it, which is a finding. A topic scoring 0 because the embedding provider
 * was down is a lie that would show up in a customer's PDF.
 */
import { ACTIVE_COVERAGE_THRESHOLDS } from "../../config/scoring/coverage.v1.js";
import { scoreTopics, type TopicMatchStats } from "../../domain/topics/coverage.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { degraded } from "../../domain/shared/app-error.js";
import type { JobLogger } from "../ports/job-context.port.js";
import type { ChunksRepo } from "../../infrastructure/db/repositories/chunks.repo.js";
import type { CrawlsRepo } from "../../infrastructure/db/repositories/crawls.repo.js";
import type { TopicsRepo } from "../../infrastructure/db/repositories/topics.repo.js";
import type { TopicCoverageRepo } from "../../infrastructure/db/repositories/topic-coverage.repo.js";

export interface ComputeTopicCoverageDeps {
  readonly chunks: ChunksRepo;
  readonly crawls: CrawlsRepo;
  readonly topics: TopicsRepo;
  readonly coverage: TopicCoverageRepo;
  readonly log: JobLogger;
}

export interface ComputeTopicCoverageInput {
  readonly projectId: string;
  readonly crawlId: string;
}

export interface ComputeTopicCoverageResult {
  readonly topicsScored: number;
  readonly chunksConsidered: number;
  readonly topicsCovered: number;
}

/** Why coverage could not be produced — recorded verbatim in the analysis artifact. */
type UnavailableReason = "no_taxonomy" | "no_embeddings";

async function recordUnavailable(
  deps: ComputeTopicCoverageDeps,
  crawlId: string,
  reason: UnavailableReason,
): Promise<void> {
  await deps.crawls.mergeAnalysis(crawlId, {
    topicCoverage: { available: false, reason },
  });
}

export async function computeTopicCoverage(
  deps: ComputeTopicCoverageDeps,
  input: ComputeTopicCoverageInput,
): Promise<Result<ComputeTopicCoverageResult, AppError>> {
  const thresholds = ACTIVE_COVERAGE_THRESHOLDS;
  const topics = await deps.topics.listForProject(input.projectId, "ACTIVE");

  if (topics.length === 0) {
    await recordUnavailable(deps, input.crawlId, "no_taxonomy");
    return err(degraded("The project has no active topics, so coverage cannot be computed."));
  }

  const embeddedChunks = await deps.chunks.countEmbeddedForCrawl(input.crawlId);
  if (embeddedChunks === 0) {
    // Either nothing was indexed or every embedding call failed. Both leave coverage
    // genuinely unknown; neither is "the site covers nothing".
    await recordUnavailable(deps, input.crawlId, "no_embeddings");
    return err(degraded("This crawl has no embedded chunks, so coverage cannot be computed."));
  }

  const matches = await deps.chunks.topicMatches(
    input.projectId,
    input.crawlId,
    thresholds.matchThreshold,
    thresholds.evidenceChunks,
  );
  const byTopic = new Map(matches.map((match) => [match.topicId, match]));

  // Topics with no match at all are scored, not skipped: "we have nothing on this" is the
  // most actionable row on the coverage map.
  const stats: TopicMatchStats[] = topics.map((topic) => {
    const match = byTopic.get(topic.id);
    return {
      topicId: topic.id,
      maxSimilarity: match?.maxSimilarity ?? null,
      depthChunks: match?.depthChunks ?? 0,
      evidenceChunkIds: match?.evidenceChunkIds ?? [],
    };
  });

  const scored = scoreTopics(stats, thresholds);

  await deps.coverage.replaceForCrawl(
    input.crawlId,
    scored.map((row) => ({
      topicId: row.topicId,
      coverageScore: row.coverageScore,
      depthChunks: row.depthChunks,
      evidence: {
        chunkIds: row.evidenceChunkIds,
        maxSimilarity: row.maxSimilarity,
        thresholdsVersion: thresholds.version,
      },
    })),
  );

  const topicsCovered = scored.filter((row) => row.depthChunks > 0).length;

  await deps.crawls.mergeAnalysis(input.crawlId, {
    topicCoverage: {
      available: true,
      topicsScored: scored.length,
      topicsCovered,
      chunksConsidered: embeddedChunks,
      thresholdsVersion: thresholds.version,
    },
  });

  deps.log.info(
    {
      crawlId: input.crawlId,
      topicsScored: scored.length,
      topicsCovered,
      chunks: embeddedChunks,
    },
    "topic coverage computed",
  );

  return ok({
    topicsScored: scored.length,
    chunksConsidered: embeddedChunks,
    topicsCovered,
  });
}
