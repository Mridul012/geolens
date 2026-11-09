/**
 * Local development seed (M2).
 *
 * Idempotent by construction: every row uses a fixed id and is written with `upsert`, so
 * running it twice leaves the database in the same state — no duplicate projects, no
 * unique-constraint explosions. Produces one user, one project, its OWN site plus a
 * competitor, and one completed crawl with pages, snapshots and a score, which is enough
 * for the dashboard, the purge job (M5) and manual API pokes to have something to chew on.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Fixed ids keep the seed idempotent and make local URLs stable across resets.
const ID = {
  user: "018f0000-0000-7000-8000-000000000001",
  project: "018f0000-0000-7000-8000-000000000002",
  ownSite: "018f0000-0000-7000-8000-000000000003",
  competitorSite: "018f0000-0000-7000-8000-000000000004",
  crawl: "018f0000-0000-7000-8000-000000000005",
  score: "018f0000-0000-7000-8000-000000000006",
  subscription: "018f0000-0000-7000-8000-000000000007",
} as const;

const SEED_PAGES = [
  { path: "/", title: "Acme — AI-native analytics", words: 820, changed: true },
  { path: "/pricing", title: "Pricing", words: 410, changed: true },
  { path: "/blog/ai-search-visibility", title: "How AI search picks sources", words: 1_640, changed: true },
  { path: "/docs/getting-started", title: "Getting started", words: 950, changed: false },
  { path: "/about", title: "About Acme", words: 320, changed: false },
] as const;

function pageId(index: number): string {
  return `018f0000-0000-7000-8000-0000000001${String(index).padStart(2, "0")}`;
}

function snapshotId(index: number): string {
  return `018f0000-0000-7000-8000-0000000002${String(index).padStart(2, "0")}`;
}

async function main(): Promise<void> {
  const now = new Date();
  const crawlFinishedAt = new Date(now.getTime() - 60 * 60 * 1000);

  const user = await prisma.user.upsert({
    where: { id: ID.user },
    update: { name: "Priya (seed)" },
    create: {
      id: ID.user,
      email: "priya@acme.test",
      name: "Priya (seed)",
      emailVerified: true,
      emailVerifiedAt: now,
    },
  });

  await prisma.subscription.upsert({
    where: { id: ID.subscription },
    update: {},
    create: {
      id: ID.subscription,
      userId: user.id,
      stripeCustomerId: "cus_seed_local",
      plan: "FREE",
      status: "ACTIVE",
    },
  });

  const project = await prisma.project.upsert({
    where: { id: ID.project },
    update: { name: "Acme (seed)" },
    create: {
      id: ID.project,
      userId: user.id,
      name: "Acme (seed)",
      timezone: "Asia/Kolkata",
    },
  });

  const ownSite = await prisma.site.upsert({
    where: { id: ID.ownSite },
    update: {},
    create: {
      id: ID.ownSite,
      projectId: project.id,
      url: "https://acme.test",
      domain: "acme.test",
      role: "OWN",
      name: "Acme",
    },
  });

  await prisma.site.upsert({
    where: { id: ID.competitorSite },
    update: {},
    create: {
      id: ID.competitorSite,
      projectId: project.id,
      url: "https://rival.test",
      domain: "rival.test",
      role: "COMPETITOR",
      name: "Rival",
    },
  });

  const crawl = await prisma.crawl.upsert({
    where: { id: ID.crawl },
    update: {},
    create: {
      id: ID.crawl,
      siteId: ownSite.id,
      projectId: project.id,
      status: "COMPLETED",
      trigger: "MANUAL",
      pagesDiscovered: SEED_PAGES.length,
      pagesCrawled: SEED_PAGES.length,
      pagesChanged: SEED_PAGES.filter((page) => page.changed).length,
      pagesFailed: 0,
      aiCostUsdMicros: 312_000n,
      scoringConfigVersion: "v1",
      pipelineVersion: "seed",
      queuedAt: crawlFinishedAt,
      startedAt: crawlFinishedAt,
      finishedAt: new Date(crawlFinishedAt.getTime() + 4 * 60 * 1000),
    },
  });

  for (const [index, page] of SEED_PAGES.entries()) {
    const url = `${ownSite.url}${page.path}`;
    const contentHash = `seedhash-${index}`;
    const seededPage = await prisma.page.upsert({
      where: { id: pageId(index) },
      update: { lastSeenAt: crawlFinishedAt },
      create: {
        id: pageId(index),
        siteId: ownSite.id,
        url,
        // Deterministic stand-in for the real normalized-URL hash (arrives in M4).
        urlHash: `seedurl-${index}`,
        latestContentHash: contentHash,
        firstSeenAt: crawlFinishedAt,
        lastSeenAt: crawlFinishedAt,
      },
    });

    await prisma.pageSnapshot.upsert({
      where: { id: snapshotId(index) },
      update: {},
      create: {
        id: snapshotId(index),
        crawlId: crawl.id,
        pageId: seededPage.id,
        httpStatus: 200,
        contentHash,
        changed: page.changed,
        title: page.title,
        wordCount: page.words,
        hasStructuredData: index % 2 === 0,
        internalLinkCount: 12 - index,
        externalLinkCount: index,
        qualityScore: 70 - index * 4,
        extracted: {
          title: page.title,
          headings: [{ level: 1, text: page.title }],
          canonical: url,
        },
        storageKey: `snapshots/${project.id}/${crawl.id}/${contentHash}.html.gz`,
        fetchedAt: crawlFinishedAt,
      },
    });
  }

  await prisma.score.upsert({
    where: { id: ID.score },
    update: {},
    create: {
      id: ID.score,
      projectId: project.id,
      crawlId: crawl.id,
      composite: 54,
      scoreRetrievability: 61,
      scoreContentQuality: 66,
      scoreTopicCoverage: 48,
      scoreTechnical: 35,
      scoreTrust: 60,
      components: {
        citation: { value: null, reason: "unavailable_yet", weight: 0.35, effectiveWeight: 0 },
        retrievability: { value: 61, weight: 0.2, effectiveWeight: 0.3077 },
        contentQuality: { value: 66, weight: 0.15, effectiveWeight: 0.2308 },
        topicCoverage: { value: 48, weight: 0.15, effectiveWeight: 0.2308 },
        technical: { value: 35, weight: 0.1, effectiveWeight: 0.1538 },
        trust: { value: 60, weight: 0.05, effectiveWeight: 0.0769 },
      },
      scoringConfigVersion: "v1",
    },
  });

  await prisma.event.deleteMany({ where: { projectId: project.id, kind: "crawl_completed" } });
  await prisma.event.create({
    data: {
      projectId: project.id,
      kind: "crawl_completed",
      crawlId: crawl.id,
      payload: { pagesCrawled: SEED_PAGES.length, seeded: true },
    },
  });

  console.log(
    `Seeded user ${user.email} · project ${project.name} (${project.id}) · crawl ${crawl.id}`,
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exitCode = 1;
  });
