import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Dashboard } from "@contracts/api/dashboard";
import type { Crawl } from "@contracts/api/crawls";
import type { AccessCheck } from "@contracts/api/analysis";
import { DashboardView } from "@/app/(app)/projects/[projectId]/dashboard-view";
import { apiFetch, ApiError } from "@/lib/api/client";
import { renderWithQueryClient } from "../test-utils";

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";

const baseDashboard: Dashboard = {
  hasCompletedCrawl: false,
  latestScore: null,
  scoreTrend: [],
  crawlStatus: null,
  indexedPages: 0,
  recentPages: [],
  topRecommendations: [],
  topMissingTopics: [],
  promptSummary: null,
  comparisonSummary: null,
  builtAt: new Date().toISOString(),
  projectId: PROJECT_ID,
};

function crawl(overrides: Partial<Crawl> = {}): Crawl {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    siteId: "33333333-3333-3333-3333-333333333333",
    status: "COMPLETED",
    trigger: "MANUAL",
    stats: { pagesDiscovered: 40, pagesCrawled: 40, pagesChanged: 3, pagesFailed: 0 },
    degradation: null,
    errorReason: null,
    scoringConfigVersion: "v1",
    queuedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("DashboardView", () => {
  afterEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it("shows the pre-first-crawl empty state and a 'Start crawl' CTA", () => {
    renderWithQueryClient(<DashboardView projectId={PROJECT_ID} initialDashboard={baseDashboard} />);

    expect(screen.getByText("Nothing measured yet")).toBeInTheDocument();
    expect(screen.getByText("No crawl yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start crawl/i })).toBeEnabled();
    // Null is not zero (Frontend-Design.md §7): the score is out of focus, with words, not 0.
    expect(screen.getByText("Not yet measured")).toBeInTheDocument();
  });

  it("renders the composite score and sub-score grid once a score exists", () => {
    const dashboard: Dashboard = {
      ...baseDashboard,
      hasCompletedCrawl: true,
      crawlStatus: crawl(),
      indexedPages: 37,
      latestScore: {
        id: "44444444-4444-4444-4444-444444444444",
        composite: 72,
        scoreCitation: 65,
        scoreRetrievability: 80,
        scoreContentQuality: null,
        scoreTopicCoverage: 70,
        scoreTechnical: 90,
        scoreTrust: 60,
        crawlId: crawl().id,
        promptRunId: null,
        scoringConfigVersion: "v1",
        createdAt: new Date().toISOString(),
      },
    };

    renderWithQueryClient(<DashboardView projectId={PROJECT_ID} initialDashboard={dashboard} />);

    expect(screen.getByText("72")).toBeInTheDocument();
    expect(screen.getByText("65")).toBeInTheDocument(); // citation
    expect(screen.getByText("37")).toBeInTheDocument(); // indexed pages
    expect(screen.getByRole("button", { name: /re-run crawl/i })).toBeInTheDocument();
  });

  it("flags a degraded crawl with a banner instead of hiding the gap", () => {
    const dashboard: Dashboard = {
      ...baseDashboard,
      hasCompletedCrawl: true,
      crawlStatus: crawl({ status: "COMPLETED_DEGRADED", degradation: { "provider:gemini": true } }),
    };

    renderWithQueryClient(<DashboardView projectId={PROJECT_ID} initialDashboard={dashboard} />);

    expect(screen.getByText(/degraded during this crawl/i)).toBeInTheDocument();
  });

  it("disables the crawl button while a crawl is already in flight", () => {
    const dashboard: Dashboard = {
      ...baseDashboard,
      crawlStatus: crawl({ status: "CRAWLING", finishedAt: null }),
    };

    renderWithQueryClient(<DashboardView projectId={PROJECT_ID} initialDashboard={dashboard} />);

    expect(screen.getByRole("button", { name: /crawl in progress/i })).toBeDisabled();
  });

  it("starts a crawl with a fresh idempotency key and surfaces a failure", async () => {
    vi.mocked(apiFetch).mockRejectedValue(
      new ApiError({
        type: "https://api.geolens.example/errors/crawl-already-active",
        code: "CRAWL_ALREADY_ACTIVE",
        title: "Crawl already active",
        status: 409,
        detail: "A crawl is already running for this site.",
      }),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<DashboardView projectId={PROJECT_ID} initialDashboard={baseDashboard} />);

    await user.click(screen.getByRole("button", { name: /start crawl/i }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        `/v1/projects/${PROJECT_ID}/crawls`,
        expect.objectContaining({ method: "POST", body: {} }),
      ),
    );
    const [, options] = vi.mocked(apiFetch).mock.calls[0]!;
    expect(typeof (options as { idempotencyKey?: string }).idempotencyKey).toBe("string");
    expect(await screen.findByText("A crawl is already running for this site.")).toBeInTheDocument();
  });

  // Worst case from a break-ui pass: a long, real-shaped domain must step its type down and
  // break only after dots and hyphens, not split mid-label across six lines.
  it("sets a long domain smaller, with break points only after dots and hyphens", () => {
    const domain = "northwind-industries-holdings-international.example.co.uk";
    const { container } = renderWithQueryClient(
      <DashboardView projectId={PROJECT_ID} domain={domain} initialDashboard={baseDashboard} />,
    );

    // Screen readers get the whole name in one piece.
    expect(screen.getByText(domain)).toBeInTheDocument();
    const hero = container.querySelector(".focus-pull")!;
    expect(hero.className).toContain("text-[clamp(1.75rem,3.4vw,2.75rem)]");
    expect(hero.textContent).toBe(domain);
    // One break opportunity after each "." and "-" (and one at the end).
    const separators = domain.match(/[.-]/g)!.length;
    expect(hero.querySelectorAll("wbr")).toHaveLength(separators + 1);
  });
});

describe("DashboardView as an eye exam", () => {
  const BOTS = ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "CCBot", "Bytespider"] as const;

  function access(blocked: ReadonlyArray<(typeof BOTS)[number]> = []): AccessCheck {
    return {
      bots: BOTS.map((bot) => ({
        bot,
        operator: "Operator",
        allowed: !blocked.includes(bot),
        blockedBy: blocked.includes(bot) ? "robots" : null,
        evidence: null,
        impact: null,
        fix: null,
      })),
      llmsTxt: { present: false, valid: null, issues: [] },
      robotsTxtPresent: true,
      allowedShare: Math.round(((BOTS.length - blocked.length) / BOTS.length) * 100),
      checkedAt: new Date().toISOString(),
    };
  }

  const crawled: Dashboard = { ...baseDashboard, hasCompletedCrawl: true, crawlStatus: crawl() };

  it("asks the product's questions as chart lines, smallest last", () => {
    renderWithQueryClient(<DashboardView projectId={PROJECT_ID} initialDashboard={crawled} />);

    const questions = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(questions).toEqual([
      "Can AI reach you?",
      "Can it read you?",
      "Does it cite you?",
      "What to fix first",
      "The fine print",
    ]);
  });

  it("answers 'Can AI reach you?' from the real access check", () => {
    renderWithQueryClient(
      <DashboardView
        projectId={PROJECT_ID}
        initialDashboard={crawled}
        evidence={{ access: access(["GPTBot", "ClaudeBot"]), retrievability: null, sampleAnswer: null }}
      />,
    );

    expect(screen.getByText("Partly. 4 of 6 AI crawlers can read your site.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Get the fix" })).toHaveAttribute(
      "href",
      `/projects/${PROJECT_ID}/crawler-access`,
    );
  });

  it("says when every crawler is allowed", () => {
    renderWithQueryClient(
      <DashboardView
        projectId={PROJECT_ID}
        initialDashboard={crawled}
        evidence={{ access: access(), retrievability: null, sampleAnswer: null }}
      />,
    );

    expect(screen.getByText("Yes. All 6 AI crawlers can read your site.")).toBeInTheDocument();
  });

  it("keeps unmeasured lines out of focus with words, never as zero", () => {
    // 12 pages is a real count; what must never read "0" is an unmeasured score component.
    renderWithQueryClient(
      <DashboardView projectId={PROJECT_ID} initialDashboard={{ ...crawled, indexedPages: 12 }} />,
    );

    expect(screen.getByText("The AI crawler check runs with your first crawl.")).toBeInTheDocument();
    expect(screen.getByText(/Retrievability is measured after a crawl/)).toBeInTheDocument();
    // Six score components, none measured: each says so.
    expect(screen.getAllByText("not measured")).toHaveLength(6);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("shows one real AI answer as evidence on the cite line", () => {
    renderWithQueryClient(
      <DashboardView
        projectId={PROJECT_ID}
        initialDashboard={{
          ...crawled,
          promptSummary: { mentionRate: 40, citationShare: 25, lastRunAt: new Date().toISOString() },
        }}
        evidence={{
          access: null,
          retrievability: null,
          sampleAnswer: {
            engine: "perplexity",
            text: "For small teams, Acme is a strong pick.",
            brandMentioned: true,
            brandCited: true,
          },
        }}
      />,
    );

    expect(
      screen.getByText("AI engines mention you in 40% of answers and cite you in 25%."),
    ).toBeInTheDocument();
    expect(screen.getByText("For small teams, Acme is a strong pick.")).toBeInTheDocument();
    expect(screen.getByText(/One real answer from perplexity, which cites you/)).toBeInTheDocument();
  });

  it("links the read line to the page lens on the latest completed crawl", () => {
    renderWithQueryClient(<DashboardView projectId={PROJECT_ID} initialDashboard={crawled} />);

    expect(screen.getByRole("link", { name: "See your pages through the lens" })).toHaveAttribute(
      "href",
      `/projects/${PROJECT_ID}/crawls/${crawl().id}#through-the-lens`,
    );
  });

  it("offers no lens link before any crawl has completed", () => {
    renderWithQueryClient(<DashboardView projectId={PROJECT_ID} initialDashboard={baseDashboard} />);

    expect(screen.queryByRole("link", { name: /through the lens/i })).not.toBeInTheDocument();
  });
});
