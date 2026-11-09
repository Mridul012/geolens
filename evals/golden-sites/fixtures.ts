/**
 * Turning a golden site's description into rows the scoring engine can read.
 *
 * Shared by `run-golden.ts` and the golden test so the CI gate and the suite score the
 * *same* corpus — a baseline that two callers build differently is not a baseline.
 */
import type { PrismaClient } from "@prisma/client";
import type { GoldenSite } from "./sites.js";

export interface PageSpec {
  readonly path: string;
  readonly wordCount: number;
  readonly structuredData: boolean;
  readonly canonical: boolean;
  readonly metaDescription: boolean;
  readonly author: boolean;
  readonly citations: number;
  readonly qualityScore: number;
  readonly dated?: boolean;
}

export interface SeededGoldenSite {
  readonly projectId: string;
  readonly siteId: string;
  readonly crawlId: string;
}

/**
 * Writes one golden site as a finished crawl: pages, page-quality scores, topic coverage
 * and the analysis artifact the earlier stages would have produced.
 *
 * Everything upstream of scoring is therefore *given*, which is the point — this eval
 * measures the scoring engine's response to a fixed set of evidence, not the crawler's or
 * the model's response to the web.
 */
export async function seedGoldenSite(
  prisma: PrismaClient,
  site: GoldenSite,
): Promise<SeededGoldenSite> {
  const user = await prisma.user.create({
    data: { email: `golden-${site.key}-${Date.now()}-${Math.random()}@example.test` },
  });
  const project = await prisma.project.create({ data: { userId: user.id, name: site.key } });
  const own = await prisma.site.create({
    data: {
      projectId: project.id,
      url: `https://${site.domain}`,
      domain: site.domain,
      role: "OWN",
    },
  });

  const crawl = await prisma.crawl.create({
    data: {
      siteId: own.id,
      projectId: project.id,
      status: "ANALYZING",
      trigger: "MANUAL",
      pagesCrawled: site.pages.length,
      analysis: {
        accessCheck: {
          allowedShare: site.botAccessShare,
          llmsTxt: { present: site.llmsTxt.present, valid: site.llmsTxt.valid, issues: [] },
          robotsTxtPresent: true,
        },
        discovery: { source: site.sitemapPresent ? "sitemap" : "links", sitemapPresent: site.sitemapPresent },
        ...(site.retrievability === null
          ? { retrievability: { available: false, reason: "judge_unavailable" } }
          : { retrievability: { available: true, score: site.retrievability, questionsTotal: 36 } }),
        topicCoverage: { available: true, topicsScored: site.topics.length },
      },
    },
  });

  for (const [index, page] of site.pages.entries()) {
    const row = await prisma.page.create({
      data: {
        siteId: own.id,
        url: `https://${site.domain}${page.path}`,
        urlHash: `${site.key}-${index}`,
        latestContentHash: `c${index}`,
      },
    });
    await prisma.pageSnapshot.create({
      data: {
        crawlId: crawl.id,
        pageId: row.id,
        contentHash: `c${index}`,
        httpStatus: 200,
        title: `Page ${index}`,
        wordCount: page.wordCount,
        hasStructuredData: page.structuredData,
        internalLinkCount: site.pages.length - index,
        qualityScore: page.qualityScore,
        quality: { promptId: "page-quality/v1" },
        ...(page.dated === true ? { pageUpdatedAt: new Date("2026-01-01T00:00:00Z") } : {}),
        extracted: {
          canonical: page.canonical ? `https://${site.domain}${page.path}` : null,
          metaDescription: page.metaDescription ? `About ${page.path}` : null,
          signals: { hasAuthor: page.author, outboundCitationCount: page.citations },
        },
        storageKey: `${site.key}/${index}`,
        fetchedAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
  }

  for (const [position, topic] of site.topics.entries()) {
    const row = await prisma.topic.create({
      data: {
        projectId: project.id,
        label: topic.label,
        source: "GENERATED",
        buyerIntent: topic.intent,
        position,
      },
    });
    await prisma.topicCoverage.create({
      data: {
        crawlId: crawl.id,
        topicId: row.id,
        coverageScore: topic.coverage,
        depthChunks: Math.max(1, Math.round(topic.coverage / 20)),
      },
    });
  }

  // A competitor, where the site declares one, so missing-topic detection is exercised.
  if (site.competitorCoverage !== undefined) {
    const rival = await prisma.site.create({
      data: {
        projectId: project.id,
        url: `https://rival-${site.key}.example`,
        domain: `rival-${site.key}.example`,
        role: "COMPETITOR",
      },
    });
    const rivalCrawl = await prisma.crawl.create({
      data: {
        siteId: rival.id,
        projectId: project.id,
        status: "COMPLETED",
        trigger: "MANUAL",
        finishedAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    const topics = await prisma.topic.findMany({ where: { projectId: project.id } });
    for (const [label, coverageScore] of Object.entries(site.competitorCoverage)) {
      const topic = topics.find((row) => row.label === label);
      if (topic === undefined) continue;
      await prisma.topicCoverage.create({
        data: { crawlId: rivalCrawl.id, topicId: topic.id, coverageScore, depthChunks: 8 },
      });
    }
  }

  return { projectId: project.id, siteId: own.id, crawlId: crawl.id };
}
