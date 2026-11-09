import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { Comparison } from "@contracts/api/comparison";
import { ComparisonView } from "@/app/(app)/projects/[projectId]/comparison/comparison-view";
import { apiFetch } from "@/lib/api/client";
import { renderWithQueryClient } from "../test-utils";

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const OWN_SITE_ID = "22222222-2222-2222-2222-222222222222";
const COMPETITOR_SITE_ID = "33333333-3333-3333-3333-333333333333";
const OWN_CRAWL_ID = "44444444-4444-4444-4444-444444444444";

const emptyMetrics = {
  aiVisibility: null,
  topicCoverage: null,
  authority: null,
  contentFreshness: null,
  pageCount: null,
  blogCoverage: null,
  trustSignals: null,
};

const filledMetrics = {
  aiVisibility: 72,
  topicCoverage: 60,
  authority: 55,
  contentFreshness: 80,
  pageCount: 120,
  blogCoverage: 40,
  trustSignals: 90,
};

const baseComparison: Comparison = {
  own: {
    siteId: OWN_SITE_ID,
    domain: "geolens.example",
    name: "GEOlens",
    crawlId: OWN_CRAWL_ID,
    metrics: filledMetrics,
  },
  competitor: null,
  shareOfVoice: null,
  missingTopics: [],
};

describe("ComparisonView", () => {
  afterEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it("renders an empty state when the project tracks no competitor at all", () => {
    renderWithQueryClient(
      <ComparisonView projectId={PROJECT_ID} initialComparison={baseComparison} />,
    );

    expect(screen.getByText("No competitor tracked")).toBeInTheDocument();
    expect(screen.getByText("Add a competitor to unlock comparison.")).toBeInTheDocument();
    // Own side still renders normally.
    expect(screen.getByText("GEOlens")).toBeInTheDocument();
    expect(screen.getByText("72")).toBeInTheDocument();
    // Share of voice and missing topics render their own "not yet measured" / empty states.
    expect(
      screen.getByText("not yet measured — run prompt tracking to see share of voice"),
    ).toBeInTheDocument();
    expect(screen.getByText("No coverage gaps found.")).toBeInTheDocument();
  });

  it("shows the competitor card with per-metric 'not yet measured' when added but not yet crawled", () => {
    const comparison: Comparison = {
      ...baseComparison,
      competitor: {
        siteId: COMPETITOR_SITE_ID,
        domain: "competitor.example",
        name: "Competitor Co",
        crawlId: null,
        metrics: emptyMetrics,
      },
    };

    renderWithQueryClient(
      <ComparisonView projectId={PROJECT_ID} initialComparison={comparison} />,
    );

    // Domain/name still shown for an added-but-uncrawled competitor.
    expect(screen.getByText("Competitor Co")).toBeInTheDocument();
    expect(screen.getByText("competitor.example")).toBeInTheDocument();
    expect(
      screen.getByText("Not yet crawled — metrics will appear once a crawl completes."),
    ).toBeInTheDocument();
    // Null is not zero: every metric on the competitor card says "not measured" (drawn out
    // of focus), never "0".
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    const unmeasured = screen.getAllByText("not measured");
    expect(unmeasured.length).toBeGreaterThanOrEqual(Object.keys(emptyMetrics).length);
  });

  it("renders a fully populated comparison with share of voice and missing topics", () => {
    const comparison: Comparison = {
      own: baseComparison.own,
      competitor: {
        siteId: COMPETITOR_SITE_ID,
        domain: "competitor.example",
        name: "Competitor Co",
        crawlId: "55555555-5555-5555-5555-555555555555",
        metrics: {
          aiVisibility: 50,
          topicCoverage: 45,
          authority: 60,
          contentFreshness: 30,
          pageCount: 90,
          blogCoverage: 20,
          trustSignals: 65,
        },
      },
      shareOfVoice: {
        overall: 63,
        perEngine: [
          { engine: "chatgpt", ownCitations: 12, competitorCitations: 4, shareOfVoice: 75 },
          { engine: "perplexity", ownCitations: 3, competitorCitations: 3, shareOfVoice: null },
        ],
        competitorCitations: { "Competitor Co": 7 },
        runId: "66666666-6666-6666-6666-666666666666",
        measuredAt: new Date().toISOString(),
      },
      missingTopics: [
        {
          topicId: "77777777-7777-7777-7777-777777777777",
          label: "Pricing comparisons",
          ownCoverage: 10,
          ownDepth: 1,
          competitorCoverage: 80,
          gap: 70,
          missing: false,
        },
        {
          topicId: "88888888-8888-8888-8888-888888888888",
          label: "Integration guides",
          ownCoverage: null,
          ownDepth: null,
          competitorCoverage: 90,
          gap: null,
          missing: true,
        },
      ],
    };

    renderWithQueryClient(
      <ComparisonView projectId={PROJECT_ID} initialComparison={comparison} />,
    );

    // Competitor card metrics (name appears twice: the card title and the
    // per-engine competitor-citations list further down).
    expect(screen.getAllByText("Competitor Co").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("50")).toBeInTheDocument();

    // Share of voice overall + per-engine table.
    expect(screen.getByText("63%")).toBeInTheDocument();
    expect(screen.getByText("chatgpt")).toBeInTheDocument();
    expect(screen.getByText("perplexity")).toBeInTheDocument();
    expect(screen.getByText("75%")).toBeInTheDocument();
    // "Competitor citations" appears both as the per-engine table column header and the
    // section label above the competitor-citations list.
    expect(screen.getAllByText("Competitor citations").length).toBeGreaterThanOrEqual(2);

    // Missing topics table: one row with a gap, one flagged as fully missing.
    expect(screen.getByText("Pricing comparisons")).toBeInTheDocument();
    expect(screen.getByText("70")).toBeInTheDocument();
    expect(screen.getByText("Integration guides")).toBeInTheDocument();
    expect(screen.getByText("missing")).toBeInTheDocument();
  });
});
