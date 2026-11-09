/**
 * The executive summary (AI-Pipeline §3.6) — the paragraph at the top of the dashboard.
 *
 * One frontier call per crawl, and the only model output a customer reads verbatim. Two
 * constraints shape it:
 *
 * **It is given findings, never pages.** The input is the assembled analysis — component
 * scores, access-check results, coverage gaps, unanswered questions. Raw page HTML never
 * reaches this tier, so a page cannot address the model that writes the customer's summary
 * (AI-Pipeline §6).
 *
 * **It degrades silently.** A crawl with no summary shows its findings without a
 * paragraph; a crawl with an invented one shows a lie. If the call fails, nothing is
 * written and nothing is retried.
 */
import type { ExecSummaryOutput } from "../../contracts/ai/exec-summary.js";
import { execSummaryOutputSchema } from "../../contracts/ai/exec-summary.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { notFound } from "../../domain/shared/app-error.js";
import type { AiGateway } from "../ports/ai-gateway.port.js";
import type { JobLogger } from "../ports/job-context.port.js";
import type { CrawlsRepo } from "../../infrastructure/db/repositories/crawls.repo.js";
import type { SitesRepo } from "../../infrastructure/db/repositories/sites.repo.js";
import type { TopicCoverageRepo } from "../../infrastructure/db/repositories/topic-coverage.repo.js";
import type { TopicsRepo } from "../../infrastructure/db/repositories/topics.repo.js";

export interface GenerateExecSummaryDeps {
  readonly gateway: AiGateway;
  readonly crawls: CrawlsRepo;
  readonly sites: SitesRepo;
  readonly topics: TopicsRepo;
  readonly coverage: TopicCoverageRepo;
  readonly log: JobLogger;
  readonly prompt: (name: string, version: string) => {
    id: string;
    system: string;
    user: string;
  };
  readonly render: (template: string, variables: Record<string, string>) => string;
}

export interface GenerateExecSummaryInput {
  readonly projectId: string;
  readonly crawlId: string;
  readonly siteId: string;
  readonly composite: number | null;
  /** The breakdown payload `computeScore` produced. */
  readonly components: Record<string, unknown>;
  readonly requestId?: string | undefined;
}

/** Weakest coverage first — the findings most worth writing about. */
const GAP_LIMIT = 5;
const UNANSWERED_LIMIT = 5;

interface BreakdownRow {
  component?: unknown;
  value?: unknown;
  reason?: unknown;
}

function renderComponents(components: Record<string, unknown>): string {
  const rows = Array.isArray(components["components"])
    ? (components["components"] as BreakdownRow[])
    : [];
  return rows
    .map((row) => {
      const name = String(row.component ?? "unknown");
      if (typeof row.value === "number") return `- ${name}: ${row.value}`;
      return `- ${name}: not measured (${String(row.reason ?? "unavailable")})`;
    })
    .join("\n");
}

export async function generateExecSummary(
  deps: GenerateExecSummaryDeps,
  input: GenerateExecSummaryInput,
): Promise<Result<ExecSummaryOutput, AppError>> {
  const site = await deps.sites.findInProject(input.projectId, input.siteId);
  if (site === null) return err(notFound("Site"));

  const artifact = (await deps.crawls.findAnalysis(input.projectId, input.crawlId)) ?? {};
  const findings: string[] = [];

  // Blocked bots first: it is the single most consequential finding the product produces.
  const accessCheck = artifact["accessCheck"] as
    | { bots?: Array<{ bot?: unknown; allowed?: unknown; blockedBy?: unknown }>; llmsTxt?: { present?: unknown } }
    | undefined;
  const blocked = (accessCheck?.bots ?? []).filter((bot) => bot.allowed === false);
  findings.push(
    blocked.length === 0
      ? "AI crawler access: every checked bot can reach the site."
      : `AI crawler access: blocked for ${blocked
          .map((bot) => `${String(bot.bot)} (by ${String(bot.blockedBy ?? "unknown")})`)
          .join(", ")}.`,
  );
  if (accessCheck?.llmsTxt?.present !== true) {
    findings.push("llms.txt: not present.");
  }

  // Coverage gaps.
  const topics = await deps.topics.listForProject(input.projectId, "ACTIVE");
  const labels = new Map(topics.map((topic) => [topic.id, topic.label]));
  const coverage = [...(await deps.coverage.listForCrawl(input.crawlId))]
    .sort((a, b) => a.coverageScore - b.coverageScore)
    .slice(0, GAP_LIMIT);
  if (coverage.length > 0) {
    findings.push(
      `Weakest topic coverage: ${coverage
        .map((row) => `${labels.get(row.topicId) ?? "unknown"} (${row.coverageScore})`)
        .join(", ")}.`,
    );
  }

  // Questions the site's own content could not answer.
  const retrievability = artifact["retrievability"] as
    | { topGaps?: Array<{ question?: unknown; missingElement?: unknown }> }
    | undefined;
  const gaps = (retrievability?.topGaps ?? []).slice(0, UNANSWERED_LIMIT);
  if (gaps.length > 0) {
    findings.push(
      `Buyer questions the site does not answer: ${gaps
        .map((gap) => String(gap.question))
        .join(" | ")}.`,
    );
  }

  const template = deps.prompt("exec-summary", "v1");
  const response = await deps.gateway.structured<ExecSummaryOutput>({
    tier: "frontier",
    promptId: template.id,
    systemPrompt: template.system,
    userPrompt: deps.render(template.user, {
      siteDomain: site.domain,
      composite: input.composite === null ? "not published yet" : String(input.composite),
      components: renderComponents(input.components),
      findings: findings.join("\n"),
    }),
    schema: execSummaryOutputSchema,
    context: {
      purpose: "exec-summary",
      projectId: input.projectId,
      crawlId: input.crawlId,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    },
  });

  if (!response.ok) {
    deps.log.warn(
      { crawlId: input.crawlId, reason: response.error.detail },
      "executive summary unavailable; the analysis renders without one",
    );
    return err(response.error);
  }

  const summary = response.value.output;
  await deps.crawls.mergeAnalysis(input.crawlId, {
    executiveSummary: summary.summary,
    strengths: summary.strengths,
    weaknesses: summary.weaknesses,
    execSummaryPromptId: template.id,
  });

  return ok(summary);
}
