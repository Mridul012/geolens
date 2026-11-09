import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Crawl } from "@contracts/api/crawls";
import { CrawlsView } from "@/app/(app)/projects/[projectId]/crawls/crawls-view";
import { apiFetch, ApiError } from "@/lib/api/client";
import { renderWithQueryClient } from "../test-utils";

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}));

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";

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

describe("CrawlsView", () => {
  afterEach(() => {
    vi.mocked(apiFetch).mockReset();
    push.mockReset();
    toastError.mockReset();
  });

  it("shows an empty state when there are no crawls yet", () => {
    renderWithQueryClient(<CrawlsView projectId={PROJECT_ID} initialCrawls={{ data: [], nextCursor: null }} />);

    expect(screen.getByText(/no crawls yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start crawl/i })).toBeEnabled();
  });

  it("renders a populated list with status, trigger, and page counts", () => {
    const crawls = [
      crawl({ id: "a1", status: "COMPLETED_DEGRADED", trigger: "SCHEDULED" }),
      crawl({ id: "a2", status: "CRAWLING", stats: { pagesDiscovered: 10, pagesCrawled: 4, pagesChanged: 0, pagesFailed: 0 } }),
    ];
    renderWithQueryClient(
      <CrawlsView projectId={PROJECT_ID} initialCrawls={{ data: crawls, nextCursor: null }} />,
    );

    expect(screen.getByText("COMPLETED_DEGRADED")).toBeInTheDocument();
    expect(screen.getByText("CRAWLING")).toBeInTheDocument();
    expect(screen.getByText("Scheduled")).toBeInTheDocument();
    expect(screen.getByText("Manual")).toBeInTheDocument();
    expect(screen.getByText("4 / 10")).toBeInTheDocument();
  });

  it("shows a dash instead of coercing a null finishedAt", () => {
    const crawls = [crawl({ id: "a1", status: "CRAWLING", finishedAt: null })];
    renderWithQueryClient(
      <CrawlsView projectId={PROJECT_ID} initialCrawls={{ data: crawls, nextCursor: null }} />,
    );

    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("starts a crawl with a fresh idempotency key and navigates to its detail page", async () => {
    const created = crawl({ id: "99999999-9999-9999-9999-999999999999", status: "QUEUED" });
    // The POST creates the crawl; success then invalidates the list query, which fires a GET
    // refetch in the background. That refetch must resolve to a `Page<Crawl>`, not the single
    // created `Crawl` — otherwise `CrawlsView`'s `data.pages.flatMap(...)` maps over `undefined`
    // and throws inside an unawaited background render, failing the run via an unhandled error.
    vi.mocked(apiFetch).mockImplementation(
      (async (_path: string, options?: { method?: string }) =>
        options?.method === "POST" ? created : { data: [created], nextCursor: null }) as typeof apiFetch,
    );
    const user = userEvent.setup();
    renderWithQueryClient(<CrawlsView projectId={PROJECT_ID} initialCrawls={{ data: [], nextCursor: null }} />);

    await user.click(screen.getByRole("button", { name: /start crawl/i }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        `/v1/projects/${PROJECT_ID}/crawls`,
        expect.objectContaining({ method: "POST", body: {} }),
      ),
    );
    const [, options] = vi.mocked(apiFetch).mock.calls[0]!;
    expect(typeof (options as { idempotencyKey?: string }).idempotencyKey).toBe("string");
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/projects/${PROJECT_ID}/crawls/${created.id}`));
  });

  it("surfaces a 409 CRAWL_ALREADY_ACTIVE failure as a toast instead of crashing", async () => {
    vi.mocked(apiFetch).mockRejectedValue(
      new ApiError({
        type: "https://api.vryse.example/errors/crawl-already-active",
        code: "CRAWL_ALREADY_ACTIVE",
        title: "Crawl already active",
        status: 409,
        detail: "A crawl is already running for this site.",
      }),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<CrawlsView projectId={PROJECT_ID} initialCrawls={{ data: [], nextCursor: null }} />);

    await user.click(screen.getByRole("button", { name: /start crawl/i }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("A crawl is already running for this site."),
    );
    expect(push).not.toHaveBeenCalled();
  });
});
