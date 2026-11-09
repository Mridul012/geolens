import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Topic } from "@contracts/api/topics";
import type { TopicCoverageResponse } from "@contracts/api/coverage";
import { TopicsView } from "@/app/(app)/projects/[projectId]/topics/topics-view";
import { apiFetch, ApiError } from "@/lib/api/client";
import { renderWithQueryClient } from "../test-utils";

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";

function topic(overrides: Partial<Topic> = {}): Topic {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    label: "Pricing",
    description: "Pricing and plans",
    source: "GENERATED",
    buyerIntent: "decision",
    status: "ACTIVE",
    position: 0,
    ...overrides,
  };
}

function coverageResponse(overrides: Partial<TopicCoverageResponse> = {}): TopicCoverageResponse {
  return {
    ownCrawlId: "33333333-3333-3333-3333-333333333333",
    competitorCrawlId: "44444444-4444-4444-4444-444444444444",
    data: [],
    ...overrides,
  };
}

describe("TopicsView", () => {
  afterEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it("renders the topic list with source and buyer-intent badges", () => {
    const topics = [
      topic(),
      topic({
        id: "55555555-5555-5555-5555-555555555555",
        label: "Custom note",
        description: null,
        source: "USER",
        buyerIntent: null,
      }),
    ];

    renderWithQueryClient(
      <TopicsView projectId={PROJECT_ID} initialTopics={topics} initialCoverage={coverageResponse()} />,
    );

    expect(screen.getByText("Pricing")).toBeInTheDocument();
    expect(screen.getByText("decision")).toBeInTheDocument();
    expect(screen.getByText("Custom note")).toBeInTheDocument();
    // buyerIntent null (user-added) — no stage badge is invented for it.
    expect(screen.getAllByText("USER")).toHaveLength(1);
    expect(screen.getAllByText("GENERATED")).toHaveLength(1);
  });

  it("adds a topic through the form, validating and submitting", async () => {
    const created = topic({
      id: "66666666-6666-6666-6666-666666666666",
      label: "New topic",
      description: null,
      source: "USER",
      buyerIntent: null,
    });
    vi.mocked(apiFetch).mockImplementation(async (path, options) => {
      if (options?.method === "POST") return created;
      if (typeof path === "string" && path.endsWith("/topics")) return { data: [created] };
      throw new Error(`unexpected call: ${String(path)}`);
    });
    const user = userEvent.setup();
    renderWithQueryClient(
      <TopicsView projectId={PROJECT_ID} initialTopics={[]} initialCoverage={coverageResponse()} />,
    );

    await user.click(screen.getByRole("button", { name: /add topic/i }));
    await waitFor(() =>
      expect(screen.getByText("String must contain at least 1 character(s)")).toBeInTheDocument(),
    );
    expect(apiFetch).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Label"), "New topic");
    await user.click(screen.getByRole("button", { name: /add topic/i }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(`/v1/projects/${PROJECT_ID}/topics`, {
        method: "POST",
        body: { label: "New topic" },
      }),
    );
  });

  it("surfaces a duplicate-label error from the add-topic form", async () => {
    vi.mocked(apiFetch).mockRejectedValue(
      new ApiError({
        type: "https://api.geolens.example/errors/validation-failed",
        code: "VALIDATION_FAILED",
        title: "Validation failed",
        status: 400,
        detail: "A topic with that label already exists.",
      }),
    );
    const user = userEvent.setup();
    renderWithQueryClient(
      <TopicsView projectId={PROJECT_ID} initialTopics={[]} initialCoverage={coverageResponse()} />,
    );

    await user.type(screen.getByLabelText("Label"), "Pricing");
    await user.click(screen.getByRole("button", { name: /add topic/i }));

    expect(await screen.findByText("A topic with that label already exists.")).toBeInTheDocument();
  });

  it("archives a topic via PATCH and invalidates the topics query", async () => {
    vi.mocked(apiFetch).mockImplementation(async (path, options) => {
      if (options?.method === "PATCH") return topic({ status: "ARCHIVED" });
      if (typeof path === "string" && path.endsWith("/topics")) {
        return { data: [topic({ status: "ARCHIVED" })] };
      }
      throw new Error(`unexpected call: ${String(path)}`);
    });
    const user = userEvent.setup();
    renderWithQueryClient(
      <TopicsView
        projectId={PROJECT_ID}
        initialTopics={[topic()]}
        initialCoverage={coverageResponse()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /^archive$/i }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(`/v1/projects/${PROJECT_ID}/topics/${topic().id}`, {
        method: "PATCH",
        body: { status: "ARCHIVED" },
      }),
    );
  });

  it("shows a null-safe 'not yet measured' treatment for a competitor row with no crawl", () => {
    const coverage = coverageResponse({
      competitorCrawlId: null,
      data: [
        {
          topicId: "77777777-7777-7777-7777-777777777777",
          label: "Onboarding",
          ownCoverage: 40,
          ownDepth: 2,
          competitorCoverage: null,
          gap: null,
          missing: false,
        },
      ],
    });

    renderWithQueryClient(
      <TopicsView projectId={PROJECT_ID} initialTopics={[]} initialCoverage={coverage} />,
    );

    expect(
      screen.getByText(/no competitor crawl yet/i),
    ).toBeInTheDocument();
    expect(screen.getByText("Onboarding")).toBeInTheDocument();
    expect(screen.getByText("40")).toBeInTheDocument();
  });

  it("renders a missing badge on rows where missing is true", () => {
    const coverage = coverageResponse({
      data: [
        {
          topicId: "88888888-8888-8888-8888-888888888888",
          label: "Integrations",
          ownCoverage: 0,
          ownDepth: 0,
          competitorCoverage: 90,
          gap: 90,
          missing: true,
        },
      ],
    });

    renderWithQueryClient(
      <TopicsView projectId={PROJECT_ID} initialTopics={[]} initialCoverage={coverage} />,
    );

    const row = screen.getByText("Integrations").closest("tr");
    expect(row).not.toBeNull();
    expect(within(row!).getByText("Missing")).toBeInTheDocument();
    expect(within(row!).getByText("+90")).toBeInTheDocument();
  });
});
