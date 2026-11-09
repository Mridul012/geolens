/**
 * Prompt simulation (M15) — the product's differentiator.
 *
 * Everything else in this codebase infers AI visibility from a site's own content. This
 * asks the engines directly: the tracked prompts, run against real assistants, parsed into
 * "were they named" and "were they linked". Without it the visibility score is an estimate;
 * with it, it is a measurement.
 *
 * Four decisions carry the honesty of that measurement:
 *
 * 1. **Three samples per cell, majority vote.** Engines are non-deterministic. Asking once
 *    would make week-to-week movement mostly noise.
 * 2. **A failed sample is null, never false.** An API timeout recorded as "not mentioned"
 *    is indistinguishable, in a trend line, from genuinely losing a citation.
 * 3. **Deterministic parsing first.** A word-boundary match is exact and auditable; a model
 *    asked "was this brand mentioned?" is neither. The judge runs only on the three fixed
 *    ambiguity triggers, which on a typical run means zero calls.
 * 4. **Per-cell failures never fail the run.** One engine down is a degraded run with the
 *    other engine's numbers intact, not an empty week.
 */
import type { Engine } from "../../config/model-tiers.js";
import type { MentionJudgment } from "../../contracts/ai/mention-judge.js";
import { mentionJudgmentSchema } from "../../contracts/ai/mention-judge.js";
import { brandVariants } from "../../domain/prompts/variants.js";
import {
  detectCitation,
  detectMention,
  extractUrls,
  type ResolvedCitation,
} from "../../domain/prompts/matching.js";
import {
  aggregateCell,
  citationScore,
  summariseRun,
  type CellOutcome,
  type SampleOutcome,
} from "../../domain/prompts/metrics.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { notFound } from "../../domain/shared/app-error.js";
import type { AiGateway } from "../ports/ai-gateway.port.js";
import type { JobLogger } from "../ports/job-context.port.js";
import type { ProgressStore } from "../ports/progress-store.port.js";
import type { PublicSuffix } from "../ports/public-suffix.port.js";
import type { EventsRepo } from "../../infrastructure/db/repositories/events.repo.js";
import type { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo.js";
import type { PromptRunsRepo } from "../../infrastructure/db/repositories/prompt-runs.repo.js";
import type { PromptTemplatesRepo } from "../../infrastructure/db/repositories/prompt-templates.repo.js";
import type { SitesRepo } from "../../infrastructure/db/repositories/sites.repo.js";

export interface RunPromptSimulationDeps {
  readonly gateway: AiGateway;
  readonly runs: PromptRunsRepo;
  readonly prompts: PromptTemplatesRepo;
  readonly projects: ProjectsRepo;
  readonly sites: SitesRepo;
  readonly events: EventsRepo;
  readonly progress: ProgressStore;
  readonly publicSuffix: PublicSuffix;
  readonly log: JobLogger;
  readonly shouldStop?: (() => boolean) | undefined;
  readonly prompt: (name: string, version: string) => {
    id: string;
    system: string;
    user: string;
  };
  readonly render: (template: string, variables: Record<string, string>) => string;
}

export interface RunPromptSimulationInput {
  readonly projectId: string;
  readonly runId: string;
  readonly engines: readonly Engine[];
  readonly requestId?: string | undefined;
}

export interface RunPromptSimulationResult {
  readonly cells: number;
  readonly evaluableCells: number;
  readonly judgeCalls: number;
  readonly citationScore: number | null;
  readonly degraded: boolean;
}

/** Samples per (prompt × engine) cell. Fixed at three (AI-Pipeline §4.4). */
export const SAMPLES_PER_CELL = 3;

/** Characters of answer text kept around a match, for the judge and for evidence. */
const EXCERPT_RADIUS = 200;

function excerptAround(text: string, offset: number | null): string {
  if (offset === null) return text.slice(0, EXCERPT_RADIUS * 2);
  const start = Math.max(0, offset - EXCERPT_RADIUS);
  return text.slice(start, offset + EXCERPT_RADIUS);
}

interface BrandProfile {
  readonly name: string;
  readonly registrableDomain: string;
  readonly variants: readonly string[];
}

export async function runPromptSimulation(
  deps: RunPromptSimulationDeps,
  input: RunPromptSimulationInput,
): Promise<Result<RunPromptSimulationResult, AppError>> {
  const project = await deps.projects.findAnyById(input.projectId);
  if (project === null) return err(notFound("Project"));

  const ownSite = await deps.sites.findOwnSite(input.projectId);
  if (ownSite === null) return err(notFound("Site"));

  const templates = (await deps.prompts.listForProject(input.projectId, "ACTIVE")).filter(
    (template) => template.text.trim().length > 0,
  );
  if (templates.length === 0) return err(notFound("Tracked prompts"));

  const ownDomain = deps.publicSuffix.registrableDomain(ownSite.url) ?? ownSite.domain;
  const own: BrandProfile = {
    name: ownSite.name ?? project.name,
    registrableDomain: ownDomain,
    variants: brandVariants({
      siteName: ownSite.name,
      projectName: project.name,
      registrableDomain: ownDomain,
    }),
  };

  const competitors: readonly BrandProfile[] = (
    await deps.sites.listForProject(input.projectId, "COMPETITOR")
  ).map((site) => {
    const domain = deps.publicSuffix.registrableDomain(site.url) ?? site.domain;
    return {
      name: site.name ?? domain,
      registrableDomain: domain,
      variants: brandVariants({
        siteName: site.name,
        projectName: null,
        registrableDomain: domain,
      }),
    };
  });

  await deps.runs.markRunning(input.runId);

  const cellsTotal = templates.length * input.engines.length;
  let cellsDone = 0;
  let judgeCalls = 0;
  const judgePrompt = deps.prompt("mention-judge", "v1");

  await deps.progress.setPromptRunProgress(input.runId, { cellsDone: 0, cellsTotal });

  for (const template of templates) {
    for (const engine of input.engines) {
      if (deps.shouldStop?.() === true) {
        deps.log.warn({ runId: input.runId }, "worker draining — prompt run will resume");
        break;
      }

      const samples: SampleOutcome[] = [];

      for (let sampleIndex = 0; sampleIndex < SAMPLES_PER_CELL; sampleIndex += 1) {
        const answer = await deps.gateway.askEngine({
          tier: `engine:${engine}`,
          prompt: template.text,
          context: {
            purpose: `prompt-sim:${engine}`,
            projectId: input.projectId,
            promptRunId: input.runId,
            ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
          },
        });

        if (!answer.ok) {
          // Recorded as a failed cell, not as an absence. The distinction is the whole
          // reason the trend line can be trusted.
          await deps.runs.recordCell({
            promptRunId: input.runId,
            promptTemplateId: template.id,
            engine,
            sampleIndex,
            brandMentioned: false,
            brandCited: false,
            mentionPosition: null,
            competitorsMentioned: [],
            citations: [],
            answerText: null,
            model: engine,
            latencyMs: null,
            error: answer.error.detail ?? answer.error.code,
          });
          samples.push({
            promptTemplateId: template.id,
            engine,
            sampleIndex,
            brandMentioned: null,
            brandCited: null,
            competitorsCited: [],
            failed: true,
          });
          continue;
        }

        const text = answer.value.answerText;

        // ── Mention ───────────────────────────────────────────────────────
        let mention = detectMention(text, own.variants);
        if (mention.matched && mention.ambiguous) {
          const judged = await deps.gateway.structured<MentionJudgment>({
            tier: "bulk",
            promptId: judgePrompt.id,
            systemPrompt: judgePrompt.system,
            userPrompt: deps.render(judgePrompt.user, {
              brandName: own.name,
              brandDomain: own.registrableDomain,
              matchedText: mention.variant ?? "",
              excerpt: excerptAround(text, mention.offset),
            }),
            schema: mentionJudgmentSchema,
            context: {
              purpose: "mention-judge",
              projectId: input.projectId,
              promptRunId: input.runId,
            },
          });
          judgeCalls += 1;
          // An unreachable judge leaves the match unconfirmed. Defaulting to "yes" would
          // inflate the customer's own number on exactly the names most likely to collide.
          const confirmed = judged.ok ? judged.value.output.refersToBrand : false;
          mention = { ...mention, matched: confirmed };
        }

        // ── Citations ─────────────────────────────────────────────────────
        const urls = [...new Set([...answer.value.citations, ...extractUrls(text)])];
        const resolved: ResolvedCitation[] = urls.map((url) => ({
          url,
          registrableDomain: deps.publicSuffix.registrableDomain(url),
        }));
        const citation = detectCitation(resolved, own.registrableDomain);

        const competitorsMentioned = competitors.map((competitor) => ({
          name: competitor.registrableDomain,
          cited: detectCitation(resolved, competitor.registrableDomain).cited,
        }));

        await deps.runs.recordCell({
          promptRunId: input.runId,
          promptTemplateId: template.id,
          engine,
          sampleIndex,
          brandMentioned: mention.matched,
          brandCited: citation.cited,
          mentionPosition: mention.offset,
          competitorsMentioned,
          citations: urls,
          // The answer is kept whole: every parsed field above is a claim about it, and a
          // customer disputing one needs to be able to read the source.
          answerText: text,
          model: answer.value.model,
          latencyMs: answer.value.latencyMs,
          error: null,
        });

        samples.push({
          promptTemplateId: template.id,
          engine,
          sampleIndex,
          brandMentioned: mention.matched,
          brandCited: citation.cited,
          competitorsCited: competitorsMentioned
            .filter((competitor) => competitor.cited)
            .map((competitor) => competitor.name),
          failed: false,
        });
      }

      cellsDone += 1;
      await deps.progress.setPromptRunProgress(input.runId, { cellsDone, cellsTotal });
      void aggregateCell(samples);
    }
  }

  // ── Aggregate from what was actually stored ─────────────────────────────
  // Read back rather than folding the in-memory samples: a retried job may have written
  // some cells in an earlier attempt, and the database is the record of the run.
  const stored = await deps.runs.listSamples(input.runId);
  const byCell = new Map<string, SampleOutcome[]>();
  for (const sample of stored) {
    const key = `${sample.promptTemplateId}:${sample.engine}`;
    const existing = byCell.get(key) ?? [];
    existing.push({
      promptTemplateId: sample.promptTemplateId,
      engine: sample.engine,
      sampleIndex: sample.sampleIndex,
      brandMentioned: sample.failed ? null : sample.brandMentioned,
      brandCited: sample.failed ? null : sample.brandCited,
      competitorsCited: sample.competitorsCited,
      failed: sample.failed,
    });
    byCell.set(key, existing);
  }

  const cells: CellOutcome[] = [...byCell.values()].map((samples) => aggregateCell(samples));
  const metrics = summariseRun(cells);
  const score = citationScore(metrics);

  const finished = await deps.runs.finish(
    input.runId,
    metrics.evaluableCells === 0 ? "FAILED" : metrics.degraded ? "COMPLETED_DEGRADED" : "COMPLETED",
    {
      mentionRate: metrics.mentionRate,
      citationShare: metrics.citationShare,
      metrics: {
        cells: metrics.cells,
        evaluableCells: metrics.evaluableCells,
        partialCells: metrics.partialCells,
        shareOfVoice: metrics.shareOfVoice,
        perEngine: metrics.perEngine,
        competitorCitations: metrics.competitorCitations,
        citationScore: score,
        judgeCalls,
      },
      costUsdMicros: 0n,
    },
  );

  await deps.progress.setPromptRunProgress(input.runId, {
    cellsDone: metrics.cells,
    cellsTotal: metrics.cells,
    status: finished.status,
  });

  await deps.events.record({
    projectId: input.projectId,
    kind: finished.status === "FAILED" ? "prompt_run_failed" : "prompt_run_completed",
    payload: {
      runId: input.runId,
      mentionRate: metrics.mentionRate,
      citationShare: metrics.citationShare,
      evaluableCells: metrics.evaluableCells,
    },
  });

  deps.log.info(
    {
      runId: input.runId,
      cells: metrics.cells,
      evaluable: metrics.evaluableCells,
      judgeCalls,
      citationScore: score,
    },
    "prompt run complete",
  );

  return ok({
    cells: metrics.cells,
    evaluableCells: metrics.evaluableCells,
    judgeCalls,
    citationScore: score,
    degraded: metrics.degraded,
  });
}
