/**
 * Generating the tracked prompt set (M14, AI-Pipeline §2).
 *
 * These ten questions are the measurement instrument for the citation component — the
 * largest single weight in the composite — so what they ask determines what the product's
 * headline number means. Generated once, from the taxonomy, after the first crawl.
 *
 * **Once** is the operative word. Unlike the taxonomy, a later crawl does not regenerate
 * them: a tracked prompt's entire value is its history, and quietly swapping the set every
 * week would reset every trend line in the account while the chart carried on as if
 * nothing had happened.
 */
import type { PromptSetOutput } from "../../contracts/ai/prompt-gen.js";
import { promptSetOutputSchema } from "../../contracts/ai/prompt-gen.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { degraded, notFound } from "../../domain/shared/app-error.js";
import type { AiGateway } from "../ports/ai-gateway.port.js";
import type { JobLogger } from "../ports/job-context.port.js";
import type { CrawlsRepo } from "../../infrastructure/db/repositories/crawls.repo.js";
import type { PromptTemplatesRepo } from "../../infrastructure/db/repositories/prompt-templates.repo.js";
import { isDuplicatePrompt } from "../../infrastructure/db/repositories/prompt-templates.repo.js";
import type { SitesRepo } from "../../infrastructure/db/repositories/sites.repo.js";
import type { TopicsRepo } from "../../infrastructure/db/repositories/topics.repo.js";

export interface GeneratePromptsDeps {
  readonly gateway: AiGateway;
  readonly crawls: CrawlsRepo;
  readonly sites: SitesRepo;
  readonly topics: TopicsRepo;
  readonly prompts: PromptTemplatesRepo;
  readonly log: JobLogger;
  readonly prompt: (name: string, version: string) => {
    id: string;
    system: string;
    user: string;
  };
  readonly render: (template: string, variables: Record<string, string>) => string;
}

export interface GeneratePromptsInput {
  readonly projectId: string;
  readonly crawlId: string;
  readonly siteId: string;
  readonly requestId?: string | undefined;
}

export interface GeneratePromptsResult {
  readonly promptsCreated: number;
}

export async function generateTrackedPrompts(
  deps: GeneratePromptsDeps,
  input: GeneratePromptsInput,
): Promise<Result<GeneratePromptsResult, AppError>> {
  const site = await deps.sites.findInProject(input.projectId, input.siteId);
  if (site === null) return err(notFound("Site"));

  // Stated up front rather than discovered by hitting the active-text unique index: a
  // project that already has its seed set is the ordinary steady state, and expressing it
  // as a constraint violation would surface as a thrown error and three job retries for
  // something that is not a failure at all.
  //
  // Keyed on *generated* prompts, not on all of them: a user who added one by hand before
  // the first crawl finished should still get the ten.
  if ((await deps.prompts.countGenerated(input.projectId)) > 0) {
    return err(degraded("This project already has its generated prompt set."));
  }

  const topics = await deps.topics.listForProject(input.projectId, "ACTIVE");
  if (topics.length === 0) {
    // Documented dependency (AI-Pipeline §3.1): no taxonomy means no prompt generation.
    await deps.crawls.mergeAnalysis(input.crawlId, {
      trackedPrompts: { available: false, reason: "no_taxonomy" },
    });
    return err(degraded("The project has no taxonomy, so prompts cannot be generated."));
  }

  const analysis = (await deps.crawls.findAnalysis(input.projectId, input.crawlId)) ?? {};
  const taxonomy = analysis["taxonomy"] as { niche?: unknown } | undefined;
  const competitors = await deps.sites.listForProject(input.projectId, "COMPETITOR");

  const template = deps.prompt("prompt-gen", "v1");
  const response = await deps.gateway.structured<PromptSetOutput>({
    tier: "frontier",
    promptId: template.id,
    systemPrompt: template.system,
    userPrompt: deps.render(template.user, {
      brandName: site.name ?? site.domain,
      siteDomain: site.domain,
      niche: typeof taxonomy?.niche === "string" ? taxonomy.niche : "this category",
      competitors:
        competitors.length === 0
          ? "(none tracked)"
          : competitors.map((competitor) => competitor.domain).join(", "),
      topics: topics
        .map((topic) => `- ${topic.label}: ${topic.description ?? "(no description)"}`)
        .join("\n"),
    }),
    schema: promptSetOutputSchema,
    context: {
      purpose: "prompt-generation",
      projectId: input.projectId,
      crawlId: input.crawlId,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    },
  });

  if (!response.ok) {
    // Degrades like everything else: the crawl completes, the user can add prompts by
    // hand, and a retry action is offered rather than an error page.
    deps.log.warn(
      { projectId: input.projectId, reason: response.error.detail },
      "prompt generation failed; the user can still add prompts by hand",
    );
    await deps.crawls.mergeAnalysis(input.crawlId, {
      trackedPrompts: { available: false, reason: "generation_failed" },
    });
    return err(response.error);
  }

  let created;
  try {
    created = await deps.prompts.createGenerated(
      input.projectId,
      response.value.output.prompts.map((prompt, index) => ({
        text: prompt.text,
        intent: prompt.intent,
        source: "GENERATED" as const,
        pinned: false,
        position: index,
      })),
    );
  } catch (error) {
    // The backstop for a race with a concurrent crawl. The transaction rolled back, so
    // nothing was half-written, and the other crawl's set stands.
    if (!isDuplicatePrompt(error)) throw error;
    deps.log.warn(
      { projectId: input.projectId },
      "prompt generation raced another crawl; the existing set stands",
    );
    return err(degraded("This project already tracks prompts; the set is generated once."));
  }

  await deps.crawls.mergeAnalysis(input.crawlId, {
    trackedPrompts: {
      available: true,
      promptsCreated: created.length,
      promptId: template.id,
    },
  });

  deps.log.info(
    { projectId: input.projectId, prompts: created.length },
    "tracked prompts generated",
  );

  return ok({ promptsCreated: created.length });
}
