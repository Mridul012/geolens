/**
 * The recommendations engine (M13, PRD FR-9) — the Monday-morning to-do list.
 *
 * Rules first, model second, and never the other way round. The rules produce findings
 * that are true by construction, so the list is never empty and never wrong at the top;
 * the model then adds the judgement calls a predicate cannot make. A model suggestion that
 * collides with a rule is discarded rather than merged — the rule is the fact.
 *
 * The other load-bearing decision is that a recommendation whose evidence cannot be
 * resolved is **dropped, not repaired** (AI-Pipeline §3.6). A card pointing at a page that
 * does not exist is exactly the generic filler the PRD names as a trust risk, and one of
 * them is enough to make a user stop reading the list. Silent dropping is safe precisely
 * because the rules guarantee the list is not empty.
 */
import { RULE_THRESHOLDS_V1 } from "../../domain/recommendations/rules.js";
import { evaluateRules, type PageRef, type SiteFindings } from "../../domain/recommendations/rules.js";
import { fingerprintOf } from "../../domain/recommendations/fingerprint.js";
import { statusAfterRecrawl } from "../../domain/recommendations/status.js";
import type { RecommendationSet } from "../../contracts/ai/recommendations.js";
import { recommendationSetSchema } from "../../contracts/ai/recommendations.js";
import { MIN_CONTENT_WORDS } from "../../config/scoring/content.js";
import { ACTIVE_COVERAGE_THRESHOLDS } from "../../config/scoring/coverage.v1.js";
import { compareCoverage } from "../../domain/topics/coverage.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { notFound } from "../../domain/shared/app-error.js";
import type { AiGateway } from "../ports/ai-gateway.port.js";
import type { Clock } from "../ports/clock.port.js";
import type { JobLogger } from "../ports/job-context.port.js";
import type { CrawlsRepo } from "../../infrastructure/db/repositories/crawls.repo.js";
import type { RecommendationsRepo } from "../../infrastructure/db/repositories/recommendations.repo.js";
import type { SiteFactsRepo } from "../../infrastructure/db/repositories/site-facts.repo.js";
import type { SitesRepo } from "../../infrastructure/db/repositories/sites.repo.js";
import type { TopicCoverageRepo } from "../../infrastructure/db/repositories/topic-coverage.repo.js";
import type { TopicsRepo } from "../../infrastructure/db/repositories/topics.repo.js";

export interface GenerateRecommendationsDeps {
  readonly gateway: AiGateway;
  readonly crawls: CrawlsRepo;
  readonly sites: SitesRepo;
  readonly topics: TopicsRepo;
  readonly coverage: TopicCoverageRepo;
  readonly siteFacts: SiteFactsRepo;
  readonly recommendations: RecommendationsRepo;
  readonly clock: Clock;
  readonly log: JobLogger;
  readonly prompt: (name: string, version: string) => {
    id: string;
    system: string;
    user: string;
  };
  readonly render: (template: string, variables: Record<string, string>) => string;
}

export interface GenerateRecommendationsInput {
  readonly projectId: string;
  readonly crawlId: string;
  readonly siteId: string;
  readonly composite: number | null;
  readonly components: Record<string, unknown>;
  readonly requestId?: string | undefined;
}

export interface GenerateRecommendationsResult {
  readonly ruleFindings: number;
  readonly aiSuggestions: number;
  readonly aiDropped: number;
  readonly created: number;
  readonly updated: number;
  readonly validated: number;
  readonly regressed: number;
}

/** Pages named per rule. Enough to be convincing, few enough to stay a card. */
const PAGE_SAMPLE = 25;

function toPageRefs(rows: ReadonlyArray<{ snapshotId: string; url: string; wordCount: number }>): PageRef[] {
  return rows.map((row) => ({ ...row }));
}

/** Renders the analysis for the model, tagging each id so the fake and the real one agree. */
function renderFindings(findings: SiteFindings, weakestPages: readonly PageRef[]): string {
  const lines: string[] = [];

  for (const bot of findings.blockedBots) {
    lines.push(`blocked-bot: ${bot.bot} (${bot.blockedBy ?? "unknown"})`);
  }
  for (const topic of findings.missingTopics) {
    lines.push(`topic: ${topic.label} (competitor ahead by ${topic.gap})`);
  }
  for (const question of findings.unansweredQuestions) {
    lines.push(
      `question: ${question.question}${
        question.missingElement === null ? "" : ` — missing: ${question.missingElement}`
      }`,
    );
  }
  for (const page of weakestPages) {
    lines.push(`snapshot: ${page.snapshotId} ${page.url} (${page.wordCount} words)`);
  }

  return lines.length === 0 ? "(no findings)" : lines.join("\n");
}

/** Ids the model is allowed to cite — anything else means the card is discarded. */
function resolvableIds(findings: SiteFindings, weakestPages: readonly PageRef[]) {
  return {
    snapshotIds: new Set(weakestPages.map((page) => page.snapshotId)),
    topicLabels: new Set(findings.missingTopics.map((topic) => topic.label)),
    questions: new Set(findings.unansweredQuestions.map((item) => item.question)),
    checkKeys: new Set([
      ...findings.blockedBots.map((bot) => bot.bot),
      "llms.txt",
      "sitemap.xml",
      "structured-data",
    ]),
  };
}

export async function generateRecommendations(
  deps: GenerateRecommendationsDeps,
  input: GenerateRecommendationsInput,
): Promise<Result<GenerateRecommendationsResult, AppError>> {
  const site = await deps.sites.findInProject(input.projectId, input.siteId);
  if (site === null) return err(notFound("Site"));

  const thresholds = RULE_THRESHOLDS_V1;
  const artifact = (await deps.crawls.findAnalysis(input.projectId, input.crawlId)) ?? {};
  const accessCheck = artifact["accessCheck"] as
    | {
        bots?: Array<{ bot?: unknown; allowed?: unknown; blockedBy?: unknown; fix?: unknown }>;
        llmsTxt?: { present?: unknown; valid?: unknown };
      }
    | undefined;
  const discovery = artifact["discovery"] as { sitemapPresent?: unknown } | undefined;
  const retrievability = artifact["retrievability"] as
    | { topGaps?: Array<{ question?: unknown; missingElement?: unknown }> }
    | undefined;

  // ── Coverage gaps, resolved exactly as the coverage endpoint resolves them ──
  const activeTopics = await deps.topics.listForProject(input.projectId, "ACTIVE");
  const own = new Map(
    (await deps.coverage.listForCrawl(input.crawlId)).map((row) => [row.topicId, row]),
  );
  let competitorCrawlId: string | null = null;
  for (const competitor of await deps.sites.listForProject(input.projectId, "COMPETITOR")) {
    const latest = await deps.crawls.findLatestCompleted(competitor.id);
    if (latest !== null) {
      competitorCrawlId = latest;
      break;
    }
  }
  const rival = new Map(
    (competitorCrawlId === null ? [] : await deps.coverage.listForCrawl(competitorCrawlId)).map(
      (row) => [row.topicId, row],
    ),
  );
  const missingTopics = compareCoverage(
    activeTopics.map((topic) => ({
      topicId: topic.id,
      label: topic.label,
      ownCoverage: own.get(topic.id)?.coverageScore ?? null,
      ownDepth: own.get(topic.id)?.depthChunks ?? null,
      competitorCoverage: rival.get(topic.id)?.coverageScore ?? null,
    })),
    ACTIVE_COVERAGE_THRESHOLDS,
  )
    .filter((row) => row.missing)
    .map((row) => ({ label: row.label, gap: row.gap ?? 0 }));

  const technical = await deps.siteFacts.technicalFacts(input.crawlId);
  const staleBefore = new Date(
    deps.clock.now().getTime() - thresholds.staleDays * 24 * 60 * 60 * 1000,
  );

  const findings: SiteFindings = {
    crawlId: input.crawlId,
    pagesTotal: technical.pagesTotal,
    blockedBots: (accessCheck?.bots ?? [])
      .filter((bot) => bot.allowed === false)
      .map((bot) => ({
        bot: String(bot.bot),
        blockedBy: (bot.blockedBy === "robots" || bot.blockedBy === "cdn" ? bot.blockedBy : null),
        fix: typeof bot.fix === "string" ? bot.fix : null,
      })),
    llmsTxtPresent: accessCheck?.llmsTxt?.present === true,
    llmsTxtValid:
      typeof accessCheck?.llmsTxt?.valid === "boolean" ? accessCheck.llmsTxt.valid : null,
    sitemapPresent: discovery?.sitemapPresent === true,
    pagesWithStructuredData: technical.pagesWithStructuredData,
    pagesMissingMetaDescription: toPageRefs(
      await deps.siteFacts.pagesMissingMetaDescription(input.crawlId, PAGE_SAMPLE),
    ),
    thinPages: toPageRefs(
      await deps.siteFacts.thinPages(input.crawlId, MIN_CONTENT_WORDS, PAGE_SAMPLE),
    ),
    stalePages: toPageRefs(
      await deps.siteFacts.stalePages(input.crawlId, staleBefore, PAGE_SAMPLE),
    ),
    orphanPages: toPageRefs(
      await deps.siteFacts.orphanPages(input.crawlId, site.url, PAGE_SAMPLE),
    ),
    missingTopics,
    unansweredQuestions: (retrievability?.topGaps ?? []).map((gap) => ({
      question: String(gap.question),
      missingElement: typeof gap.missingElement === "string" ? gap.missingElement : null,
    })),
  };

  // ── Rules ─────────────────────────────────────────────────────────────────
  const rules = evaluateRules(findings, thresholds);
  const seenFingerprints = new Set<string>();
  let created = 0;
  let updated = 0;

  for (const rule of rules) {
    const fingerprint = fingerprintOf({
      source: "RULE",
      ruleKey: rule.ruleKey,
      title: rule.title,
    });
    seenFingerprints.add(fingerprint);
    const result = await deps.recommendations.upsertByFingerprint({
      projectId: input.projectId,
      fingerprint,
      source: "RULE",
      ruleKey: rule.ruleKey,
      title: rule.title,
      body: rule.body,
      priority: rule.priority,
      impact: rule.impact,
      difficulty: rule.difficulty,
      evidence: { ...rule.evidence, crawlId: input.crawlId },
      crawlId: input.crawlId,
    });
    if (result.created) created += 1;
    else updated += 1;
  }

  // ── The model's judgement calls ───────────────────────────────────────────
  const weakestPages = [...findings.thinPages, ...findings.orphanPages].slice(0, PAGE_SAMPLE);
  const allowed = resolvableIds(findings, weakestPages);
  const template = deps.prompt("recommendations", "v1");

  const response = await deps.gateway.structured<RecommendationSet>({
    tier: "frontier",
    promptId: template.id,
    systemPrompt: template.system,
    userPrompt: deps.render(template.user, {
      siteDomain: site.domain,
      composite: input.composite === null ? "not published yet" : String(input.composite),
      components: JSON.stringify(input.components["components"] ?? []),
      existingRules: rules.map((rule) => `- ${rule.ruleKey}`).join("\n") || "(none)",
      findings: renderFindings(findings, weakestPages),
    }),
    schema: recommendationSetSchema,
    context: {
      purpose: "recommendations",
      projectId: input.projectId,
      crawlId: input.crawlId,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    },
  });

  let aiSuggestions = 0;
  let aiDropped = 0;

  if (response.ok) {
    const ruleKeys = new Set(rules.map((rule) => rule.ruleKey));

    for (const suggestion of response.value.output.recommendations) {
      const refs = suggestion.evidenceRefs;
      const unresolvable =
        (refs.snapshotIds ?? []).some((id) => !allowed.snapshotIds.has(id)) ||
        (refs.topicLabels ?? []).some((label) => !allowed.topicLabels.has(label)) ||
        (refs.questionIds ?? []).some((question) => !allowed.questions.has(question)) ||
        (refs.checkKeys ?? []).some((key) => !allowed.checkKeys.has(key));

      if (unresolvable) {
        aiDropped += 1;
        continue;
      }

      const fingerprint = fingerprintOf({
        source: "AI",
        ruleKey: null,
        ruleHint: suggestion.ruleHint,
        title: suggestion.title,
      });

      // A suggestion restating a rule is a duplicate, not a second opinion.
      if (suggestion.ruleHint !== null && ruleKeys.has(suggestion.ruleHint)) {
        aiDropped += 1;
        continue;
      }
      if (seenFingerprints.has(fingerprint)) {
        aiDropped += 1;
        continue;
      }

      seenFingerprints.add(fingerprint);
      const result = await deps.recommendations.upsertByFingerprint({
        projectId: input.projectId,
        fingerprint,
        source: "AI",
        ruleKey: null,
        title: suggestion.title,
        body: suggestion.body,
        // A model does not get to declare something CRITICAL; that is reserved for
        // findings we can prove. Its leverage still orders it within the list.
        priority: suggestion.impact >= 4 ? "HIGH" : suggestion.impact >= 3 ? "MEDIUM" : "LOW",
        impact: suggestion.impact,
        difficulty: suggestion.difficulty,
        evidence: { ...refs, crawlId: input.crawlId, promptId: template.id },
        crawlId: input.crawlId,
      });
      if (result.created) created += 1;
      else updated += 1;
      aiSuggestions += 1;
    }
  } else {
    deps.log.warn(
      { crawlId: input.crawlId, reason: response.error.detail },
      "AI recommendations unavailable; the rule findings stand on their own",
    );
  }

  // ── What this crawl did *not* see ─────────────────────────────────────────
  let validated = 0;
  let regressed = 0;
  for (const live of await deps.recommendations.liveFingerprints(input.projectId)) {
    const next = statusAfterRecrawl(live.status, seenFingerprints.has(live.fingerprint));
    if (next === null) continue;
    await deps.recommendations.setPipelineStatus(
      live.id,
      next,
      next === "VALIDATED" ? deps.clock.now() : null,
    );
    if (next === "VALIDATED") validated += 1;
    else regressed += 1;
  }

  deps.log.info(
    {
      crawlId: input.crawlId,
      rules: rules.length,
      ai: aiSuggestions,
      dropped: aiDropped,
      created,
      updated,
      validated,
      regressed,
    },
    "recommendations generated",
  );

  return ok({
    ruleFindings: rules.length,
    aiSuggestions,
    aiDropped,
    created,
    updated,
    validated,
    regressed,
  });
}
