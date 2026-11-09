/**
 * Retrievability simulation (AI-Pipeline §3.3) — the AI Readiness measurement.
 *
 * The argument the product makes here: if a site's own content cannot answer its own
 * customers' questions when it is chunked and retrieved the way an AI search engine does
 * it, then no amount of writing quality will get it cited. So we do exactly that — generate
 * the questions from the site's own taxonomy, run hybrid retrieval over the site's own
 * chunks, and have a judge say whether what came back answers them.
 *
 * That turns "AI Readiness" from a vibe into a measurement, which is the entire reason the
 * component exists. It also means the number is only as honest as its inputs, so this file
 * refuses to produce one whenever the simulation could not actually run: no taxonomy, no
 * vectors, no questions, or too few questions judged. Null means unmeasured. It never
 * means zero.
 */
import {
  ACTIVE_RETRIEVABILITY_THRESHOLDS,
  UNANSWERED_EVIDENCE_LIMIT,
} from "../../config/scoring/retrievability.v1.js";
import type { CoverageJudgment, QuestionSetOutput } from "../../contracts/ai/retrievability.js";
import {
  coverageJudgmentSchema,
  questionSetOutputSchema,
} from "../../contracts/ai/retrievability.js";
import { fuseTop } from "../../domain/retrieval/rrf.js";
import {
  summarise,
  unansweredQuestions,
  type QuestionOutcome,
  type RetrievabilityMetrics,
} from "../../domain/retrieval/metrics.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { degraded } from "../../domain/shared/app-error.js";
import type { AiGateway } from "../ports/ai-gateway.port.js";
import type { JobLogger } from "../ports/job-context.port.js";
import type { ChunkContext, ChunksRepo } from "../../infrastructure/db/repositories/chunks.repo.js";
import type { CrawlsRepo } from "../../infrastructure/db/repositories/crawls.repo.js";
import type { SitesRepo } from "../../infrastructure/db/repositories/sites.repo.js";
import type { TopicsRepo } from "../../infrastructure/db/repositories/topics.repo.js";

export interface SimulateRetrievabilityDeps {
  readonly gateway: AiGateway;
  readonly chunks: ChunksRepo;
  readonly crawls: CrawlsRepo;
  readonly sites: SitesRepo;
  readonly topics: TopicsRepo;
  readonly log: JobLogger;
  readonly prompt: (name: string, version: string) => {
    id: string;
    system: string;
    user: string;
  };
  readonly render: (template: string, variables: Record<string, string>) => string;
}

export interface SimulateRetrievabilityInput {
  readonly projectId: string;
  readonly crawlId: string;
  readonly siteId: string;
  readonly requestId?: string | undefined;
}

/** Why the simulation could not run — recorded verbatim in the analysis artifact. */
type UnavailableReason =
  | "no_taxonomy"
  | "no_embeddings"
  | "question_generation_failed"
  | "judge_unavailable";

async function recordUnavailable(
  deps: SimulateRetrievabilityDeps,
  crawlId: string,
  reason: UnavailableReason,
): Promise<void> {
  await deps.crawls.mergeAnalysis(crawlId, {
    retrievability: { available: false, reason },
  });
}

/** The passages the judge is shown, delimited so each one's provenance is visible. */
function renderContext(chunks: readonly ChunkContext[]): string {
  if (chunks.length === 0) return "(no passages were retrieved for this question)";
  return chunks
    .map((chunk, index) =>
      [
        `[${index + 1}] ${chunk.url}`,
        chunk.headingPath === null ? null : `Section: ${chunk.headingPath}`,
        chunk.content,
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
    )
    .join("\n\n---\n\n");
}

export async function simulateRetrievability(
  deps: SimulateRetrievabilityDeps,
  input: SimulateRetrievabilityInput,
): Promise<Result<RetrievabilityMetrics, AppError>> {
  const thresholds = ACTIVE_RETRIEVABILITY_THRESHOLDS;

  const topics = await deps.topics.listForProject(input.projectId, "ACTIVE");
  if (topics.length === 0) {
    await recordUnavailable(deps, input.crawlId, "no_taxonomy");
    return err(degraded("The project has no active topics, so no questions can be generated."));
  }

  const embedded = await deps.chunks.countEmbeddedForCrawl(input.crawlId);
  if (embedded === 0) {
    // Lexical-only retrieval would produce a *different* measurement wearing the same
    // name, which is worse than no number at all.
    await recordUnavailable(deps, input.crawlId, "no_embeddings");
    return err(degraded("This crawl has no embedded chunks, so retrieval cannot be simulated."));
  }

  const site = await deps.sites.findInProject(input.projectId, input.siteId);
  const analysis = (await deps.crawls.findAnalysis(input.projectId, input.crawlId)) ?? {};
  const taxonomyBlock = analysis["taxonomy"] as { niche?: unknown } | undefined;
  const niche = typeof taxonomyBlock?.niche === "string" ? taxonomyBlock.niche : "this category";

  // ── 1. Questions ──────────────────────────────────────────────────────────
  const questionsPrompt = deps.prompt("buyer-questions", "v1");
  const generated = await deps.gateway.structured<QuestionSetOutput>({
    tier: "bulk",
    promptId: questionsPrompt.id,
    systemPrompt: questionsPrompt.system,
    userPrompt: deps.render(questionsPrompt.user, {
      siteDomain: site?.domain ?? "the site",
      niche,
      topics: topics
        .map((topic) => `- ${topic.label}: ${topic.description ?? "(no description)"}`)
        .join("\n"),
      minQuestions: String(thresholds.minQuestions),
      maxQuestions: String(thresholds.maxQuestions),
    }),
    schema: questionSetOutputSchema,
    context: {
      purpose: "retrievability-questions",
      projectId: input.projectId,
      crawlId: input.crawlId,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    },
  });

  if (!generated.ok) {
    deps.log.warn(
      { crawlId: input.crawlId, reason: generated.error.detail },
      "buyer question generation failed; retrievability unavailable",
    );
    await recordUnavailable(deps, input.crawlId, "question_generation_failed");
    return err(generated.error);
  }

  const questions = generated.value.output.questions;

  // ── 2. Retrieval ──────────────────────────────────────────────────────────
  // Every question embeds in one call: the vector arm needs one vector each, and thirty
  // separate round trips to buy thirty vectors is the kind of waste the ledger notices.
  const questionVectors = await deps.gateway.embed({
    inputs: questions.map((question) => question.text),
    context: {
      purpose: "retrievability-question-embedding",
      projectId: input.projectId,
      crawlId: input.crawlId,
    },
  });

  if (!questionVectors.ok) {
    await recordUnavailable(deps, input.crawlId, "no_embeddings");
    return err(questionVectors.error);
  }

  // ── 3. Judgment ───────────────────────────────────────────────────────────
  const judgePrompt = deps.prompt("retrievability-judge", "v1");
  const outcomes: QuestionOutcome[] = [];

  for (const [index, question] of questions.entries()) {
    const vector = questionVectors.value.vectors[index];
    const [byVector, byText] = await Promise.all([
      vector === undefined
        ? Promise.resolve([])
        : deps.chunks.searchByVector(input.crawlId, vector, thresholds.vectorTopK),
      deps.chunks.searchByText(input.crawlId, question.text, thresholds.lexicalTopK),
    ]);

    const fused = fuseTop(
      [byVector.map((hit) => hit.id), byText.map((hit) => hit.id)],
      thresholds.rrfK,
      thresholds.contextChunks,
    );
    const context = await deps.chunks.loadContext(fused);

    const judged = await deps.gateway.structured<CoverageJudgment>({
      tier: "judge",
      promptId: judgePrompt.id,
      systemPrompt: judgePrompt.system,
      userPrompt: deps.render(judgePrompt.user, {
        question: question.text,
        context: renderContext(context),
      }),
      schema: coverageJudgmentSchema,
      context: {
        purpose: "retrievability-judge",
        projectId: input.projectId,
        crawlId: input.crawlId,
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      },
    });

    outcomes.push({
      question: question.text,
      topicLabel: question.topicLabel,
      // A single failed judgment costs one question, not the component. The share of
      // questions actually judged is what decides whether the score survives.
      answered: judged.ok ? judged.value.output.answered : null,
      confidence: judged.ok ? judged.value.output.confidence : null,
      missingElement: judged.ok ? judged.value.output.missingElement : null,
      chunkIds: fused,
    });
  }

  const metrics = summarise(outcomes, thresholds);

  if (metrics.degraded) {
    deps.log.warn(
      {
        crawlId: input.crawlId,
        judged: metrics.questionsJudged,
        total: metrics.questionsTotal,
      },
      "too few questions judged; retrievability unavailable",
    );
    await recordUnavailable(deps, input.crawlId, "judge_unavailable");
    return err(
      degraded(
        `Only ${metrics.questionsJudged} of ${metrics.questionsTotal} questions could be judged.`,
      ),
    );
  }

  await deps.crawls.mergeAnalysis(input.crawlId, {
    retrievability: {
      available: true,
      score: metrics.score,
      questionsTotal: metrics.questionsTotal,
      questionsJudged: metrics.questionsJudged,
      questionsAnswered: metrics.questionsAnswered,
      questionsPartial: metrics.questionsPartial,
      questionsUnanswered: metrics.questionsUnanswered,
      thresholdsVersion: thresholds.version,
      promptIds: [questionsPrompt.id, judgePrompt.id],
      // The evidence trail: what was asked, what came back, and what was missing. This is
      // both the "why is my score this" answer and M13's content-gap input.
      questions: outcomes.map((outcome) => ({
        question: outcome.question,
        topicLabel: outcome.topicLabel,
        answered: outcome.answered,
        confidence: outcome.confidence,
        missingElement: outcome.missingElement,
        chunkIds: outcome.chunkIds,
      })),
      topGaps: unansweredQuestions(outcomes, UNANSWERED_EVIDENCE_LIMIT).map((outcome) => ({
        question: outcome.question,
        topicLabel: outcome.topicLabel,
        answered: outcome.answered,
        missingElement: outcome.missingElement,
      })),
    },
  });

  deps.log.info(
    {
      crawlId: input.crawlId,
      score: metrics.score,
      answered: metrics.questionsAnswered,
      total: metrics.questionsTotal,
    },
    "retrievability simulated",
  );

  return ok(metrics);
}
