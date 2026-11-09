import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Dashboard } from "@contracts/api/dashboard";
import type { Crawl } from "@contracts/api/crawls";
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
    // Null is not zero (Frontend-Design.md §7): the score ring shows a dash, not 0.
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
});
