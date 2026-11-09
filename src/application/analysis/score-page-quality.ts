/**
 * Page quality scoring (AI-Pipeline §3.2) — the per-page rubric behind
 * `score_content_quality`.
 *
 * This is the highest-volume model call in a crawl, so two decisions carry most of its
 * weight:
 *
 * **Sampling.** Thirty pages, chosen as homepage + the ten most internally-linked + the
 * highest word-count changed pages. A random sample would measure a site's long tail; this
 * measures what the site itself points at.
 *
 * **Carry-forward.** An unchanged page inherits its previous rubric rather than being
 * re-scored. That is not only cheaper — re-scoring identical content would produce a
 * slightly different number each week, and the product promises a score that moves only
 * when the site does (§5.3).
 *
 * Per-page failures are tolerated. The component is valid while enough of the sample
 * scored; below that it is null, because a mean over four pages is not the same
 * measurement as a mean over thirty.
 */
import { QUALITY_SAMPLE } from "../../config/scoring/v1.js";
import type { PageQualityOutput } from "../../contracts/ai/page-quality.js";
import { pageQualityOutputSchema } from "../../contracts/ai/page-quality.js";
import { QUALITY_WEIGHTS_V1 } from "../../config/scoring/v1.js";
import { pageQualityScore } from "../../domain/scoring/components.js";
import { truncateToTokenBudget } from "../../domain/content/text.js";
import type { Result } from "../../domain/shared/result.js";
import { ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import type { AiGateway } from "../ports/ai-gateway.port.js";
import type { JobLogger } from "../ports/job-context.port.js";
import type {
  CrawlsRepo,
  QualityCandidate,
} from "../../infrastructure/db/repositories/crawls.repo.js";

export interface ScorePageQualityDeps {
  readonly gateway: AiGateway;
  readonly crawls: CrawlsRepo;
  readonly log: JobLogger;
  readonly prompt: (name: string, version: string) => {
    id: string;
    system: string;
    user: string;
  };
  readonly render: (template: string, variables: Record<string, string>) => string;
}

export interface ScorePageQualityInput {
  readonly projectId: string;
  readonly crawlId: string;
  readonly requestId?: string | undefined;
}

export interface ScorePageQualityResult {
  readonly pagesSampled: number;
  readonly pagesScored: number;
  readonly pagesCarriedForward: number;
  readonly pagesFailed: number;
}

/**
 * Chooses the sample (AI-Pipeline §3.2).
 *
 * Candidates arrive ordered by internal in-degree, so the homepage is promoted explicitly:
 * it is often linked *from* nowhere while being the page every visitor sees.
 */
export function selectQualitySample(
  candidates: readonly QualityCandidate[],
): readonly QualityCandidate[] {
  const homepage = candidates.find((candidate) => {
    try {
      return new URL(candidate.url).pathname === "/";
    } catch {
      return false;
    }
  });

  const selected: QualityCandidate[] = [];
  const seen = new Set<string>();
  const take = (candidate: QualityCandidate | undefined): void => {
    if (candidate === undefined) return;
    if (seen.has(candidate.snapshotId)) return;
    if (selected.length >= QUALITY_SAMPLE.maxPages) return;
    seen.add(candidate.snapshotId);
    selected.push(candidate);
  };

  take(homepage);
  for (const candidate of candidates.slice(0, QUALITY_SAMPLE.topByInDegree)) take(candidate);

  // The rest of the budget goes to changed pages by size: they are the ones whose score
  // cannot be inherited, so they are where a fresh call actually buys something.
  const byWords = [...candidates]
    .filter((candidate) => candidate.changed)
    .sort((a, b) => b.wordCount - a.wordCount);
  for (const candidate of byWords) take(candidate);

  // If the site is small, fill the remaining budget with whatever is left.
  for (const candidate of candidates) take(candidate);

  return selected;
}

export async function scorePageQuality(
  deps: ScorePageQualityDeps,
  input: ScorePageQualityInput,
): Promise<Result<ScorePageQualityResult, AppError>> {
  const candidates = await deps.crawls.listQualityCandidates(input.crawlId);
  const sample = selectQualitySample(candidates);

  if (sample.length === 0) {
    return ok({ pagesSampled: 0, pagesScored: 0, pagesCarriedForward: 0, pagesFailed: 0 });
  }

  const inherited = new Set<string>();
  let pagesCarriedForward = 0;
  for (const candidate of sample) {
    if (candidate.changed || candidate.carriedForwardFromId === null) continue;
    if (await deps.crawls.carryForwardQuality(candidate.snapshotId, candidate.carriedForwardFromId)) {
      inherited.add(candidate.snapshotId);
      pagesCarriedForward += 1;
    }
  }

  const toScore = sample.filter((candidate) => !inherited.has(candidate.snapshotId));
  const inputs = await deps.crawls.loadQualityInputs(toScore.map((page) => page.snapshotId));
  const template = deps.prompt("page-quality", "v1");

  let pagesScored = 0;
  let pagesFailed = 0;

  for (const page of inputs) {
    const response = await deps.gateway.structured<PageQualityOutput>({
      tier: "bulk",
      promptId: template.id,
      systemPrompt: template.system,
      userPrompt: deps.render(template.user, {
        url: page.url,
        title: page.title ?? "(none)",
        wordCount: String(page.wordCount),
        publishedAt: page.publishedAt ?? "(unknown)",
        updatedAt: page.updatedAt ?? "(unknown)",
        hasStructuredData: String(page.hasStructuredData),
        headings: page.headings.length === 0 ? "(none)" : page.headings.join("\n"),
        content: truncateToTokenBudget(page.mainText, QUALITY_SAMPLE.contentTokenBudget),
      }),
      schema: pageQualityOutputSchema,
      context: {
        purpose: "page-quality",
        projectId: input.projectId,
        crawlId: input.crawlId,
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      },
    });

    if (!response.ok) {
      // One page failing is a page, not a component. The share that scored is what decides
      // whether the component survives.
      pagesFailed += 1;
      continue;
    }

    const rubric = response.value.output;
    await deps.crawls.setQuality(page.snapshotId, pageQualityScore(rubric, QUALITY_WEIGHTS_V1), {
      ...rubric,
      promptId: template.id,
    });
    pagesScored += 1;
  }

  deps.log.info(
    {
      crawlId: input.crawlId,
      sampled: sample.length,
      scored: pagesScored,
      carriedForward: pagesCarriedForward,
      failed: pagesFailed,
    },
    "page quality scored",
  );

  return ok({
    pagesSampled: sample.length,
    pagesScored: pagesScored + pagesCarriedForward,
    pagesCarriedForward,
    pagesFailed,
  });
}
