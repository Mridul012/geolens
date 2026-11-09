import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProjectDetail } from "@contracts/api/projects";
import type { Crawl } from "@contracts/api/crawls";
import type { AccessCheck } from "@contracts/api/analysis";
import { CrawlerAccessView } from "@/app/(app)/projects/[projectId]/crawler-access/crawler-access-view";
import { apiFetch } from "@/lib/api/client";
import { renderWithQueryClient } from "../test-utils";

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const CRAWL_ID = "22222222-2222-2222-2222-222222222222";

function project(overrides: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    id: PROJECT_ID,
    name: "Acme",
    status: "ACTIVE",
    timezone: "UTC",
    createdAt: new Date().toISOString(),
    sites: [],
    latestCrawl: null,
    latestScore: null,
    ...overrides,
  };
}

function crawl(overrides: Partial<Crawl> = {}): Crawl {
  return {
    id: CRAWL_ID,
    siteId: "33333333-3333-3333-3333-333333333333",
    status: "COMPLETED",
    trigger: "MANUAL",
    stats: { pagesDiscovered: 10, pagesCrawled: 10, pagesChanged: 1, pagesFailed: 0 },
    degradation: null,
    errorReason: null,
    scoringConfigVersion: "v1",
    queuedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ...overrides,
  };
}

function accessCheck(overrides: Partial<AccessCheck> = {}): AccessCheck {
  return {
    bots: [
      bot({ bot: "GPTBot", operator: "OpenAI" }),
      bot({ bot: "ClaudeBot", operator: "Anthropic" }),
      bot({ bot: "PerplexityBot", operator: "Perplexity" }),
      bot({ bot: "Google-Extended", operator: "Google" }),
      bot({ bot: "CCBot", operator: "Common Crawl" }),
      bot({ bot: "Bytespider", operator: "ByteDance" }),
    ],
    llmsTxt: { present: true, valid: true, issues: [] },
    robotsTxtPresent: true,
    allowedShare: 100,
    checkedAt: new Date().toISOString(),
    ...overrides,
  };
}

function bot(overrides: Partial<AccessCheck["bots"][number]> = {}): AccessCheck["bots"][number] {
  return {
    bot: "GPTBot",
    operator: "OpenAI",
    allowed: true,
    blockedBy: null,
    evidence: null,
    // Matches the real contract: an allowed bot never carries impact copy (src/domain/crawl/access-check.ts).
    impact: null,
    fix: null,
    ...overrides,
  };
}

describe("CrawlerAccessView", () => {
  afterEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it("shows the no-crawl-yet empty state with a link back to the dashboard", () => {
    renderWithQueryClient(
      <CrawlerAccessView
        projectId={PROJECT_ID}
        initialProject={project({ latestCrawl: null })}
        initialAccessCheck={null}
      />,
    );

    expect(screen.getByText("No crawl yet")).toBeInTheDocument();
    // Rendered as an <a> styled as a button (nativeButton={false}), so Base UI exposes it
    // with role="button" rather than the anchor's implicit "link" role.
    expect(screen.getByRole("button", { name: /go to dashboard/i })).toHaveAttribute(
      "href",
      `/projects/${PROJECT_ID}`,
    );
    // No access data to render — the six-bot table and summary stats stay hidden.
    expect(screen.queryByText("Bot-by-bot access")).not.toBeInTheDocument();
  });

  it("shows a still-analyzing state while the crawl is in flight", () => {
    renderWithQueryClient(
      <CrawlerAccessView
        projectId={PROJECT_ID}
        initialProject={project({ latestCrawl: crawl({ status: "CRAWLING", finishedAt: null }) })}
        initialAccessCheck={null}
      />,
    );

    expect(screen.getByText("Still analyzing — check back shortly")).toBeInTheDocument();
  });

  it("renders a fully-open access check with every bot allowed", () => {
    renderWithQueryClient(
      <CrawlerAccessView
        projectId={PROJECT_ID}
        initialProject={project({ latestCrawl: crawl() })}
        initialAccessCheck={accessCheck()}
      />,
    );

    // The headline "aha" stat.
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.getAllByText("Allowed")).toHaveLength(6);
    expect(screen.getByText("GPTBot")).toBeInTheDocument();
    expect(screen.getByText("Bytespider")).toBeInTheDocument();
    // llms.txt and robots.txt summary stats.
    expect(screen.getByText("Valid")).toBeInTheDocument();
    expect(screen.getAllByText("Present")).toHaveLength(2);
  });

  it("renders a mixed allowed/blocked access check with a copyable fix snippet", async () => {
    // `userEvent.setup()` attaches its own clipboard stub to `navigator.clipboard` the
    // moment it runs, which would clobber a mock defined beforehand — so set up the user
    // first and only then install the mock the assertion actually checks.
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    renderWithQueryClient(
      <CrawlerAccessView
        projectId={PROJECT_ID}
        initialProject={project({ latestCrawl: crawl() })}
        initialAccessCheck={accessCheck({
          allowedShare: 50,
          robotsTxtPresent: true,
          bots: [
            bot({ bot: "GPTBot", operator: "OpenAI", allowed: true }),
            bot({
              bot: "ClaudeBot",
              operator: "Anthropic",
              allowed: false,
              blockedBy: "robots",
              evidence: "Disallow: / for user-agent ClaudeBot",
              impact: "Anthropic's crawler cannot read any page on your site.",
              fix: "User-agent: ClaudeBot\nAllow: /",
            }),
          ],
        })}
      />,
    );

    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("Allowed")).toBeInTheDocument();
    expect(screen.getByText("Blocked by robots.txt")).toBeInTheDocument();
    expect(screen.getByText("Disallow: / for user-agent ClaudeBot")).toBeInTheDocument();
    // An allowed bot must never render impact copy next to its "Allowed" badge — that
    // would contradict the verdict (the bug this regression test guards against). A blocked
    // bot keeps its impact text.
    const gptRow = screen.getByText("GPTBot").closest("div.border-b") as HTMLElement;
    expect(within(gptRow).queryByText(/cannot read/i)).not.toBeInTheDocument();
    expect(screen.getByText("Anthropic's crawler cannot read any page on your site.")).toBeInTheDocument();
    // The fix snippet preserves its newline — disable whitespace collapsing so the match
    // doesn't silently pass against a mangled single-line string.
    expect(
      screen.getByText("User-agent: ClaudeBot\nAllow: /", { collapseWhitespace: false }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /copy/i }));

    expect(writeText).toHaveBeenCalledWith("User-agent: ClaudeBot\nAllow: /");
  });
});
