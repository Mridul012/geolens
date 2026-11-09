/**
 * The access check against fixture servers with real per-user-agent behaviour (M8
 * acceptance): a blocked bot is a finding, not a crawl failure, and the result reaches the
 * analysis endpoint within the crawl's runtime.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pino } from "pino";
import type { PrismaClient } from "@prisma/client";
import { runAccessCheckForCrawl } from "../../../src/application/access-check/run-access-check.js";
import { HttpAccessProber } from "../../../src/infrastructure/crawler/access-prober.adapter.js";
import { CrawlsRepo } from "../../../src/infrastructure/db/repositories/crawls.repo.js";
import { EventsRepo } from "../../../src/infrastructure/db/repositories/events.repo.js";
import { SitesRepo } from "../../../src/infrastructure/db/repositories/sites.repo.js";
import { socketTransport, type DnsResolver } from "../../../src/infrastructure/crawler/ssrf-guard.js";
import type { AccessCheckResult } from "../../../src/domain/crawl/access-check.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;
let server: Server | null = null;

const log = pino({ level: "silent" });
const resolver: DnsResolver = async () => [{ address: "93.184.216.34", family: 4 }];

interface SiteBehaviour {
  readonly robotsTxt?: string | null;
  readonly llmsTxt?: string | null;
  /** Statuses keyed by a user-agent substring — how a CDN block actually manifests. */
  readonly blockUserAgents?: Readonly<Record<string, number>>;
}

/** A fixture origin that answers differently depending on who is asking. */
async function startSite(behaviour: SiteBehaviour): Promise<{ transport: typeof socketTransport }> {
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const agent = (req.headers["user-agent"] ?? "").toLowerCase();

    for (const [token, status] of Object.entries(behaviour.blockUserAgents ?? {})) {
      if (agent.includes(token.toLowerCase())) {
        res.writeHead(status, { "content-type": "text/plain" });
        res.end("blocked");
        return;
      }
    }

    if (path === "/robots.txt") {
      if (behaviour.robotsTxt === null || behaviour.robotsTxt === undefined) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(behaviour.robotsTxt);
      return;
    }

    if (path === "/llms.txt") {
      if (behaviour.llmsTxt === null || behaviour.llmsTxt === undefined) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/markdown" });
      res.end(behaviour.llmsTxt);
      return;
    }

    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body><h1>Acme</h1></body></html>");
  });

  await new Promise<void>((resolve) => (server as Server).listen(0, "127.0.0.1", resolve));
  const port = ((server as Server).address() as AddressInfo).port;

  const transport: typeof socketTransport = async (url, _pinned, options) => {
    const local = new URL(url.href);
    local.protocol = "http:";
    local.port = String(port);
    return socketTransport(local, { hostname: "acme.com", address: "127.0.0.1", family: 4 }, options);
  };

  return { transport };
}

async function seed(): Promise<{ projectId: string; siteId: string; crawlId: string }> {
  const user = await prisma.user.create({
    data: { email: `access-${Date.now()}-${Math.random()}@example.test` },
  });
  const project = await prisma.project.create({ data: { userId: user.id, name: "Access" } });
  const site = await prisma.site.create({
    data: { projectId: project.id, url: "https://acme.com", domain: "acme.com", role: "OWN" },
  });
  const crawl = await prisma.crawl.create({
    data: { siteId: site.id, projectId: project.id, status: "ANALYZING", trigger: "MANUAL" },
  });
  return { projectId: project.id, siteId: site.id, crawlId: crawl.id };
}

function deps(transport: typeof socketTransport) {
  return {
    crawls: new CrawlsRepo(prisma),
    sites: new SitesRepo(prisma),
    events: new EventsRepo(prisma),
    prober: new HttpAccessProber({
      userAgent: "VryseBot/1.0",
      timeoutMs: 5_000,
      resolver,
      transport,
    }),
    clock: { now: () => new Date("2026-08-31T00:00:00.000Z") },
    log,
  };
}

beforeAll(() => {
  prisma = createTestPrisma();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await truncateAll(prisma);
});

afterEach(async () => {
  if (server !== null) {
    const closing = server;
    server = null;
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
});

describe("a fully open site", () => {
  it("reports every bot allowed and a valid llms.txt", async () => {
    const { transport } = await startSite({
      robotsTxt: "User-agent: *\nAllow: /",
      llmsTxt: "# Acme\n- [Docs](https://acme.com/docs)",
    });
    const seeded = await seed();

    const result = await runAccessCheckForCrawl(deps(transport), seeded);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.allowedShare).toBe(100);
    expect(result.value.bots.every((finding) => finding.allowed)).toBe(true);
    expect(result.value.llmsTxt).toMatchObject({ present: true, valid: true });
    expect(result.value.robotsTxtPresent).toBe(true);
  });

  it("writes the result into the crawl's analysis artifact", async () => {
    const { transport } = await startSite({ robotsTxt: "User-agent: *\nAllow: /" });
    const seeded = await seed();

    await runAccessCheckForCrawl(deps(transport), seeded);

    const crawl = await prisma.crawl.findUniqueOrThrow({ where: { id: seeded.crawlId } });
    const analysis = crawl.analysis as { accessCheck?: AccessCheckResult };
    expect(analysis.accessCheck?.bots).toHaveLength(6);
    expect(analysis.accessCheck?.checkedAt).toBe("2026-08-31T00:00:00.000Z");
  });
});

describe("a robots-blocked site", () => {
  it("finds the blocked bot and attaches a copy-paste fix", async () => {
    const { transport } = await startSite({
      robotsTxt: "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /",
    });
    const seeded = await seed();

    const result = await runAccessCheckForCrawl(deps(transport), seeded);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const gpt = result.value.bots.find((finding) => finding.bot === "GPTBot");
    expect(gpt?.allowed).toBe(false);
    expect(gpt?.blockedBy).toBe("robots");
    expect(gpt?.fix).toContain("User-agent: GPTBot");
    expect(result.value.bots.filter((finding) => finding.allowed)).toHaveLength(5);
  });

  it("records the finding in the History feed on a first crawl", async () => {
    const { transport } = await startSite({ robotsTxt: "User-agent: GPTBot\nDisallow: /" });
    const seeded = await seed();

    await runAccessCheckForCrawl(deps(transport), seeded);

    const events = await prisma.event.findMany({ where: { projectId: seeded.projectId } });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("ai_crawler_blocked");
    expect(events[0]?.payload).toMatchObject({ first: true });
  });
});

describe("a CDN-blocked site", () => {
  it("distinguishes an edge block from a robots block", async () => {
    // robots.txt says yes; the edge refuses the bot's user agent. The most confusing
    // failure a site owner can have, because their own config looks fine.
    const { transport } = await startSite({
      robotsTxt: "User-agent: *\nAllow: /",
      blockUserAgents: { gptbot: 403 },
    });
    const seeded = await seed();

    const result = await runAccessCheckForCrawl(deps(transport), seeded);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const gpt = result.value.bots.find((finding) => finding.bot === "GPTBot");
    expect(gpt?.allowed).toBe(false);
    expect(gpt?.blockedBy).toBe("cdn");
    expect(gpt?.evidence).toContain("403");
    expect(gpt?.fix).toContain("CDN or WAF");
  });

  it("catches an edge that blocks every AI bot but serves browsers", async () => {
    const { transport } = await startSite({
      robotsTxt: "User-agent: *\nAllow: /",
      blockUserAgents: {
        gptbot: 403,
        claudebot: 403,
        perplexitybot: 403,
        "google-extended": 403,
        ccbot: 403,
        bytespider: 403,
      },
    });
    const seeded = await seed();

    const result = await runAccessCheckForCrawl(deps(transport), seeded);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.allowedShare).toBe(0);
    expect(result.value.bots.every((finding) => finding.blockedBy === "cdn")).toBe(true);
  });
});

describe("llms.txt variants", () => {
  it("reports absence honestly", async () => {
    const { transport } = await startSite({ robotsTxt: "User-agent: *\nAllow: /", llmsTxt: null });
    const seeded = await seed();

    const result = await runAccessCheckForCrawl(deps(transport), seeded);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.llmsTxt).toEqual({ present: false, valid: null, issues: [] });
  });

  it("flags an invalid file with actionable issues", async () => {
    const { transport } = await startSite({
      robotsTxt: "User-agent: *\nAllow: /",
      llmsTxt: "we have a website",
    });
    const seeded = await seed();

    const result = await runAccessCheckForCrawl(deps(transport), seeded);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.llmsTxt.present).toBe(true);
    expect(result.value.llmsTxt.valid).toBe(false);
    expect(result.value.llmsTxt.issues.length).toBeGreaterThan(0);
  });
});

describe("change reporting", () => {
  it("reports a bot that became blocked since the last crawl", async () => {
    const { transport } = await startSite({ robotsTxt: "User-agent: GPTBot\nDisallow: /" });
    const seeded = await seed();

    const previous: AccessCheckResult = {
      bots: [
        {
          bot: "GPTBot",
          operator: "OpenAI",
          allowed: true,
          blockedBy: null,
          evidence: null,
          impact: "",
          fix: null,
        },
      ],
      llmsTxt: { present: true, valid: true, issues: [] },
      robotsTxtPresent: true,
      allowedShare: 100,
      checkedAt: "2026-08-24T00:00:00.000Z",
    };

    await runAccessCheckForCrawl(deps(transport), { ...seeded, previous });

    const events = await prisma.event.findMany({ where: { projectId: seeded.projectId } });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("ai_crawler_blocked");
    expect(events[0]?.payload).toMatchObject({ first: false });
  });

  it("reports a bot that became unblocked, and stays quiet when nothing moved", async () => {
    const { transport } = await startSite({ robotsTxt: "User-agent: *\nAllow: /" });
    const seeded = await seed();

    const previous: AccessCheckResult = {
      bots: [
        {
          bot: "GPTBot",
          operator: "OpenAI",
          allowed: false,
          blockedBy: "robots",
          evidence: null,
          impact: "",
          fix: null,
        },
      ],
      llmsTxt: { present: false, valid: null, issues: [] },
      robotsTxtPresent: true,
      allowedShare: 0,
      checkedAt: "2026-08-24T00:00:00.000Z",
    };

    await runAccessCheckForCrawl(deps(transport), { ...seeded, previous });

    const events = await prisma.event.findMany({ where: { projectId: seeded.projectId } });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("ai_crawler_unblocked");

    // A second identical check reports nothing — the feed is "what changed".
    await truncateAll(prisma);
    const second = await seed();
    const unchanged: AccessCheckResult = {
      ...previous,
      bots: previous.bots.map((bot) => ({ ...bot, allowed: true, blockedBy: null })),
    };
    await runAccessCheckForCrawl(deps(transport), { ...second, previous: unchanged });
    expect(await prisma.event.count({ where: { projectId: second.projectId } })).toBe(0);
  });
});

describe("failure behaviour", () => {
  it("treats an unreachable site as a finding, not a crash", async () => {
    // No server at all: every probe fails, robots.txt is absent.
    const seeded = await seed();
    const deadTransport: typeof socketTransport = async () => {
      throw new Error("ECONNREFUSED");
    };

    const result = await runAccessCheckForCrawl(deps(deadTransport), seeded);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Absent robots.txt is the standard's "allowed" default — we do not invent a block.
    expect(result.value.robotsTxtPresent).toBe(false);
    expect(result.value.allowedShare).toBe(100);
    expect(result.value.llmsTxt.present).toBe(false);
  });
});
