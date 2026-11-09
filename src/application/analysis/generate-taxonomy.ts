/**
 * Taxonomy generation (AI-Pipeline §3.1) — the first real AI feature, and the thing
 * coverage, retrievability and prompt generation all stand on.
 *
 * Failure behaviour is specified: on a second failure the crawl completes *without* a
 * taxonomy, and everything downstream is flagged unavailable rather than faked. The user
 * gets a retry action, not an error page (§3.1, §9).
 */
import type { TaxonomyOutput } from "../../contracts/ai/taxonomy.js";
import { taxonomyOutputSchema } from "../../contracts/ai/taxonomy.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { notFound } from "../../domain/shared/app-error.js";
import { truncateToTokenBudget } from "../../domain/content/text.js";
import type { AiGateway } from "../ports/ai-gateway.port.js";
import type { CrawlsRepo } from "../../infrastructure/db/repositories/crawls.repo.js";
import type { SitesRepo } from "../../infrastructure/db/repositories/sites.repo.js";
import type { TopicsRepo } from "../../infrastructure/db/repositories/topics.repo.js";
import type { JobLogger } from "../ports/job-context.port.js";

export interface GenerateTaxonomyDeps {
  readonly gateway: AiGateway;
  readonly crawls: CrawlsRepo;
  readonly sites: SitesRepo;
  readonly topics: TopicsRepo;
  readonly log: JobLogger;
  /** Loads the versioned prompt; injected so the use case never reads the filesystem. */
  readonly prompt: (name: string, version: string) => {
    id: string;
    system: string;
    user: string;
  };
  readonly render: (template: string, variables: Record<string, string>) => string;
}

export interface GenerateTaxonomyInput {
  readonly projectId: string;
  readonly crawlId: string;
  readonly siteId: string;
  readonly requestId?: string | undefined;
}

export interface GenerateTaxonomyResult {
  readonly topicsCreated: number;
  readonly niche: string;
  readonly embeddingsStored: number;
}

/** Highest-authority pages, by internal in-degree — the site's own view of what matters. */
const SAMPLE_PAGES = 15;
/** Keeps the prompt inside a sane input cost even for a verbose site. */
const PAGE_CONTEXT_TOKEN_BUDGET = 3_000;

export async function generateTaxonomy(
  deps: GenerateTaxonomyDeps,
  input: GenerateTaxonomyInput,
): Promise<Result<GenerateTaxonomyResult, AppError>> {
  const site = await deps.sites.findInProject(input.projectId, input.siteId);
  if (site === null) return err(notFound("Site"));

  const pages = await deps.crawls.listTopPagesForCrawl(input.crawlId, SAMPLE_PAGES);
  if (pages.length === 0) {
    return err(notFound("Crawled pages"));
  }

  const homepage = pages.find((page) => new URL(page.url).pathname === "/") ?? pages[0];

  // Page content is third-party data, delimited in the prompt and never interpolated into
  // an instruction sentence (AI-Pipeline §6.1).
  const pageBlock = truncateToTokenBudget(
    pages
      .map((page) =>
        [
          `URL: ${page.url}`,
          `Title: ${page.title ?? "(none)"}`,
          `Description: ${page.metaDescription ?? "(none)"}`,
          `Headings: ${page.headings.slice(0, 8).join(" | ")}`,
        ].join("\n"),
      )
      .join("\n\n---\n\n"),
    PAGE_CONTEXT_TOKEN_BUDGET,
  );

  const template = deps.prompt("taxonomy", "v1");
  const response = await deps.gateway.structured<TaxonomyOutput>({
    tier: "frontier",
    promptId: template.id,
    systemPrompt: template.system,
    userPrompt: deps.render(template.user, {
      siteDomain: site.domain,
      homepageTitle: homepage?.title ?? site.domain,
      homepageDescription: homepage?.metaDescription ?? "(none)",
      pages: pageBlock,
    }),
    schema: taxonomyOutputSchema,
    context: {
      purpose: "taxonomy",
      projectId: input.projectId,
      crawlId: input.crawlId,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    },
  });

  if (!response.ok) {
    // Documented degradation: no taxonomy means coverage, retrievability and prompt
    // generation are skipped and flagged — never invented.
    deps.log.warn(
      { projectId: input.projectId, crawlId: input.crawlId, reason: response.error.detail },
      "taxonomy generation failed; downstream analysis will be flagged unavailable",
    );
    await deps.crawls.mergeAnalysis(input.crawlId, {
      taxonomy: { available: false, reason: "generation_failed" },
    });
    return err(response.error);
  }

  const taxonomy = response.value.output;

  const created = await deps.topics.replaceGenerated(
    input.projectId,
    taxonomy.topics.map((topic, index) => ({
      label: topic.label,
      description: topic.description,
      source: "GENERATED" as const,
      // Persisted rather than discarded: `score_topic_coverage` weights decision-stage
      // topics 2x (AI-Pipeline §3.4, ADR 0004).
      buyerIntent: topic.buyerIntent,
      position: index,
    })),
  );

  // The centroid is what maps chunks to topics in M10. A failure here costs coverage, not
  // the taxonomy — the topics are already saved and editable.
  let embeddingsStored = 0;
  const embedded = await deps.gateway.embed({
    inputs: taxonomy.topics.map((topic) => `${topic.label}. ${topic.description}`),
    context: {
      purpose: "taxonomy-embedding",
      projectId: input.projectId,
      crawlId: input.crawlId,
    },
  });

  if (embedded.ok) {
    for (const [index, topic] of created.entries()) {
      const vector = embedded.value.vectors[index];
      if (vector === undefined) continue;
      await deps.topics.setEmbedding(topic.id, vector);
      embeddingsStored += 1;
    }
  } else {
    deps.log.warn(
      { projectId: input.projectId, reason: embedded.error.detail },
      "topic embeddings unavailable; coverage will be skipped for this crawl",
    );
  }

  await deps.crawls.mergeAnalysis(input.crawlId, {
    taxonomy: {
      available: true,
      niche: taxonomy.niche,
      topicCount: created.length,
      promptId: template.id,
    },
  });

  deps.log.info(
    {
      projectId: input.projectId,
      topics: created.length,
      embeddings: embeddingsStored,
      repaired: response.value.repaired,
    },
    "taxonomy generated",
  );

  return ok({
    topicsCreated: created.length,
    niche: taxonomy.niche,
    embeddingsStored,
  });
}
