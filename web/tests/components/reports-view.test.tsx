import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Report } from "@contracts/api/reports";
import { ReportsView, type ReportsPage } from "@/app/(app)/projects/[projectId]/reports/reports-view";
import { apiFetch, ApiError, API_BASE_URL } from "@/lib/api/client";
import { toast } from "sonner";
import { renderWithQueryClient } from "../test-utils";

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, apiFetch: vi.fn() };
});

// jsdom doesn't implement `window.matchMedia`, which sonner's real <Toaster> needs at mount
// time, and tests/setup.ts (shared test infra, out of this screen's scope) has no polyfill for
// it. Mocking `sonner` and asserting `toast.error` was called sidesteps that without touching
// shared test setup.
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";

function report(overrides: Partial<Report> = {}): Report {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    kind: "ON_DEMAND",
    status: "READY",
    crawlId: "33333333-3333-3333-3333-333333333333",
    promptRunId: null,
    sizeBytes: 204800,
    generatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function reportsPage(data: Report[]): ReportsPage {
  return { data, nextCursor: null };
}

describe("ReportsView", () => {
  afterEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it("shows an empty state when there are no reports yet", () => {
    renderWithQueryClient(
      <ReportsView projectId={PROJECT_ID} initialReports={reportsPage([])} />,
    );

    expect(screen.getByText("No reports yet.")).toBeInTheDocument();
  });

  it("generates a report with a fresh idempotency key and invalidates the list on success", async () => {
    const created = report({ id: "44444444-4444-4444-4444-444444444444", status: "QUEUED" });
    vi.mocked(apiFetch).mockImplementation(async (_path, options) =>
      options?.method === "POST" ? created : reportsPage([created]),
    );
    const user = userEvent.setup();
    renderWithQueryClient(
      <ReportsView projectId={PROJECT_ID} initialReports={reportsPage([])} />,
    );

    await user.click(screen.getByRole("button", { name: /generate report/i }));
    await user.click(screen.getByRole("button", { name: /^generate$/i }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        `/v1/projects/${PROJECT_ID}/reports`,
        expect.objectContaining({ method: "POST", body: {} }),
      ),
    );
    const [, options] = vi.mocked(apiFetch).mock.calls[0]!;
    expect(typeof (options as { idempotencyKey?: string }).idempotencyKey).toBe("string");

    // All sections stay checked by default, so `sections` is omitted entirely per the
    // API contract (defaults to all five) — not sent as an explicit full array.
    expect((options as { body?: unknown }).body).toEqual({});
  });

  it("only sends `sections` when the user deliberately deselects one", async () => {
    const created = report({ status: "QUEUED" });
    vi.mocked(apiFetch).mockImplementation(async (_path, options) =>
      options?.method === "POST" ? created : reportsPage([created]),
    );
    const user = userEvent.setup();
    renderWithQueryClient(
      <ReportsView projectId={PROJECT_ID} initialReports={reportsPage([])} />,
    );

    await user.click(screen.getByRole("button", { name: /generate report/i }));
    await user.click(screen.getByLabelText("Comparison"));
    await user.click(screen.getByRole("button", { name: /^generate$/i }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        `/v1/projects/${PROJECT_ID}/reports`,
        expect.objectContaining({
          body: { sections: ["summary", "score", "trends", "recommendations"] },
        }),
      ),
    );
  });

  it("toasts a clear message on 409 NO_COMPLETED_CRAWL", async () => {
    vi.mocked(apiFetch).mockRejectedValue(
      new ApiError({
        type: "https://api.geolens.example/errors/no-completed-crawl",
        code: "NO_COMPLETED_CRAWL",
        title: "No completed crawl",
        status: 409,
        detail: "This project has no completed crawl yet.",
      }),
    );
    const user = userEvent.setup();
    renderWithQueryClient(
      <ReportsView projectId={PROJECT_ID} initialReports={reportsPage([])} />,
    );

    await user.click(screen.getByRole("button", { name: /generate report/i }));
    await user.click(screen.getByRole("button", { name: /^generate$/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Run a crawl before generating a report"),
    );
  });

  it("enables download only for a READY report, disabling it for a GENERATING one", () => {
    const ready = report({ id: "55555555-5555-5555-5555-555555555555", status: "READY" });
    const generating = report({
      id: "66666666-6666-6666-6666-666666666666",
      status: "GENERATING",
      sizeBytes: null,
      generatedAt: null,
    });
    renderWithQueryClient(
      <ReportsView projectId={PROJECT_ID} initialReports={reportsPage([ready, generating])} />,
    );

    // Rows render in list order after the header row: [header, ready, generating].
    const rows = screen.getAllByRole("row");
    const readyRow = rows[1]!;
    const generatingRow = rows[2]!;

    const downloadLink = within(readyRow).getByRole("link", { name: /download/i });
    expect(downloadLink).toHaveAttribute(
      "href",
      `${API_BASE_URL}/v1/projects/${PROJECT_ID}/reports/${ready.id}/download`,
    );

    const downloadButton = within(generatingRow).getByRole("button", { name: /download/i });
    expect(downloadButton).toBeDisabled();
  });
});
