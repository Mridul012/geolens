import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Recommendation, RecommendationDetail } from "@contracts/api/recommendations";
import { RecommendationsView } from "@/app/(app)/projects/[projectId]/recommendations/recommendations-view";
import { apiFetch, ApiError } from "@/lib/api/client";
import { renderWithQueryClient } from "../test-utils";

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}));

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const REC_ID = "22222222-2222-2222-2222-222222222222";
const LIST_PATH = `/v1/projects/${PROJECT_ID}/recommendations?limit=50`;

function recommendation(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    id: REC_ID,
    title: "Add an llms.txt file",
    source: "RULE",
    priority: "HIGH",
    impact: 4,
    difficulty: 2,
    status: "OPEN",
    firstSeenAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function recommendationDetail(overrides: Partial<RecommendationDetail> = {}): RecommendationDetail {
  return {
    ...recommendation(),
    body: "GPTBot cannot find topic guidance for this page — add an llms.txt entry.",
    ruleKey: "llms-txt-missing",
    evidence: { checkKey: "llms_txt_present", crawlPageId: "33333333-3333-3333-3333-333333333333" },
    firstSeenCrawlId: "44444444-4444-4444-4444-444444444444",
    lastSeenCrawlId: "44444444-4444-4444-4444-444444444444",
    resolvedAt: null,
    ...overrides,
  };
}

describe("RecommendationsView", () => {
  afterEach(() => {
    vi.mocked(apiFetch).mockReset();
    toastError.mockReset();
  });

  it("renders a list with mixed priorities, color-coded from CRITICAL down to LOW", () => {
    const recs = [
      recommendation({ id: "a1", title: "Fix robots.txt block", priority: "CRITICAL" }),
      recommendation({ id: "a2", title: "Add an llms.txt file", priority: "HIGH" }),
      recommendation({ id: "a3", title: "Expand pricing page depth", priority: "MEDIUM" }),
      recommendation({ id: "a4", title: "Add FAQ schema", priority: "LOW" }),
    ];

    renderWithQueryClient(
      <RecommendationsView projectId={PROJECT_ID} initialRecommendations={recs} />,
    );

    expect(screen.getByText("Fix robots.txt block")).toBeInTheDocument();
    expect(screen.getByText("Add an llms.txt file")).toBeInTheDocument();
    expect(screen.getByText("Expand pricing page depth")).toBeInTheDocument();
    expect(screen.getByText("Add FAQ schema")).toBeInTheDocument();
    expect(screen.getByText("CRITICAL")).toBeInTheDocument();
    expect(screen.getByText("HIGH")).toBeInTheDocument();
    expect(screen.getByText("MEDIUM")).toBeInTheDocument();
    expect(screen.getByText("LOW")).toBeInTheDocument();
    // The initial default-filter list comes from `initialData` — no fetch on mount.
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("renders a VALIDATED item as a non-interactive badge with no status-change controls in its detail sheet", async () => {
    const rec = recommendation({ status: "VALIDATED" });
    const detail = recommendationDetail({ status: "VALIDATED" });
    vi.mocked(apiFetch).mockImplementation(async (path) => {
      if (typeof path === "string" && path === `/v1/projects/${PROJECT_ID}/recommendations/${REC_ID}`) {
        return detail;
      }
      throw new Error(`unexpected call: ${String(path)}`);
    });
    const user = userEvent.setup();
    renderWithQueryClient(
      <RecommendationsView projectId={PROJECT_ID} initialRecommendations={[rec]} />,
    );

    expect(screen.getByText("VALIDATED")).toBeInTheDocument();
    await user.click(screen.getByText(rec.title));

    expect(await screen.findByText(/pipeline-verified status/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /mark done/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^dismiss$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reopen/i })).not.toBeInTheDocument();
  });

  it("renders a REGRESSED item as a non-interactive badge with no status-change controls in its detail sheet", async () => {
    const rec = recommendation({ status: "REGRESSED" });
    const detail = recommendationDetail({ status: "REGRESSED" });
    vi.mocked(apiFetch).mockImplementation(async (path) => {
      if (typeof path === "string" && path === `/v1/projects/${PROJECT_ID}/recommendations/${REC_ID}`) {
        return detail;
      }
      throw new Error(`unexpected call: ${String(path)}`);
    });
    const user = userEvent.setup();
    renderWithQueryClient(
      <RecommendationsView projectId={PROJECT_ID} initialRecommendations={[rec]} />,
    );

    expect(screen.getByText("REGRESSED")).toBeInTheDocument();
    await user.click(screen.getByText(rec.title));

    expect(await screen.findByText(/pipeline-verified status/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /mark done/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^dismiss$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reopen/i })).not.toBeInTheDocument();
  });

  it("marks an OPEN recommendation done and invalidates the list", async () => {
    const rec = recommendation({ status: "OPEN" });
    const detail = recommendationDetail({ status: "OPEN" });
    vi.mocked(apiFetch).mockImplementation(async (path, options) => {
      const method = options?.method ?? "GET";
      if (method === "PATCH" && path === `/v1/projects/${PROJECT_ID}/recommendations/${REC_ID}`) {
        expect(options?.body).toEqual({ status: "DONE" });
        return recommendation({ status: "DONE" });
      }
      if (path === `/v1/projects/${PROJECT_ID}/recommendations/${REC_ID}`) return detail;
      if (path === LIST_PATH) return { data: [recommendation({ status: "DONE" })], nextCursor: null };
      throw new Error(`unexpected call: ${String(path)} ${method}`);
    });
    const user = userEvent.setup();
    renderWithQueryClient(
      <RecommendationsView projectId={PROJECT_ID} initialRecommendations={[rec]} />,
    );

    await user.click(screen.getByText(rec.title));
    await screen.findByText(detail.body);
    await user.click(screen.getByRole("button", { name: /mark done/i }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        `/v1/projects/${PROJECT_ID}/recommendations/${REC_ID}`,
        expect.objectContaining({ method: "PATCH", body: { status: "DONE" } }),
      ),
    );
    // The mutation's onSuccess invalidates the recommendations list, so it refetches.
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(LIST_PATH));
    // The detail panel reflects the new status without a manual refetch.
    expect(await screen.findByRole("button", { name: /reopen/i })).toBeInTheDocument();
  });

  it("dismisses an OPEN recommendation", async () => {
    const rec = recommendation({ status: "OPEN" });
    const detail = recommendationDetail({ status: "OPEN" });
    vi.mocked(apiFetch).mockImplementation(async (path, options) => {
      const method = options?.method ?? "GET";
      if (method === "PATCH" && path === `/v1/projects/${PROJECT_ID}/recommendations/${REC_ID}`) {
        expect(options?.body).toEqual({ status: "DISMISSED" });
        return recommendation({ status: "DISMISSED" });
      }
      if (path === `/v1/projects/${PROJECT_ID}/recommendations/${REC_ID}`) return detail;
      if (path === LIST_PATH) return { data: [recommendation({ status: "DISMISSED" })], nextCursor: null };
      throw new Error(`unexpected call: ${String(path)} ${method}`);
    });
    const user = userEvent.setup();
    renderWithQueryClient(
      <RecommendationsView projectId={PROJECT_ID} initialRecommendations={[rec]} />,
    );

    await user.click(screen.getByText(rec.title));
    await screen.findByText(detail.body);
    await user.click(screen.getByRole("button", { name: /^dismiss$/i }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        `/v1/projects/${PROJECT_ID}/recommendations/${REC_ID}`,
        expect.objectContaining({ method: "PATCH", body: { status: "DISMISSED" } }),
      ),
    );
    expect(await screen.findByRole("button", { name: /reopen/i })).toBeInTheDocument();
  });

  it("surfaces a 400 illegal-transition failure via toast instead of crashing or silently updating", async () => {
    const rec = recommendation({ status: "OPEN" });
    const detail = recommendationDetail({ status: "OPEN" });
    vi.mocked(apiFetch).mockImplementation(async (path, options) => {
      const method = options?.method ?? "GET";
      if (method === "PATCH") {
        throw new ApiError({
          type: "https://api.vryse.example/errors/validation-failed",
          code: "VALIDATION_FAILED",
          title: "Validation failed",
          status: 400,
          detail: "This recommendation was already resolved and can no longer be marked done.",
        });
      }
      if (path === `/v1/projects/${PROJECT_ID}/recommendations/${REC_ID}`) return detail;
      throw new Error(`unexpected call: ${String(path)} ${method}`);
    });
    const user = userEvent.setup();
    renderWithQueryClient(
      <RecommendationsView projectId={PROJECT_ID} initialRecommendations={[rec]} />,
    );

    await user.click(screen.getByText(rec.title));
    await screen.findByText(detail.body);
    await user.click(screen.getByRole("button", { name: /mark done/i }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "This recommendation was already resolved and can no longer be marked done.",
      ),
    );
    // The failed mutation must not have silently flipped the visible status.
    expect(screen.getByRole("button", { name: /mark done/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reopen/i })).not.toBeInTheDocument();
    // And the list must not have been (wrongly) invalidated on failure.
    expect(apiFetch).not.toHaveBeenCalledWith(LIST_PATH);
  });
});
