import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Crawl, CrawlStatus } from "@contracts/api/crawls";
import type { PageSnapshotDetail, PageSnapshotSummary } from "@contracts/api/snapshots";
import type { Page } from "@contracts/api/common";
import { CrawlDetailView } from "@/app/(app)/projects/[projectId]/crawls/[crawlId]/crawl-detail-view";
import { apiFetch, ApiError, API_BASE_URL } from "@/lib/api/client";
import { renderWithQueryClient } from "../test-utils";

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}));

/**
 * `crawl-detail-view.tsx` opens a real `EventSource` while a crawl is in flight. jsdom has no
 * SSE implementation, so letting the component reach the real constructor would throw. This
 * fake gives it something to call `addEventListener`/`removeEventListener`/`close` on, and lets
 * tests drive server frames deterministically via `.emit(type, data)` instead of racing a
 * network connection.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readonly withCredentials: boolean;
  closed = false;
  private readonly listeners = new Map<string, Set<(event: { data?: string }) => void>>();

  constructor(url: string, options?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = options?.withCredentials ?? false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data?: string }) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (event: { data?: string }) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data?: unknown) {
    const event = data === undefined ? {} : { data: typeof data === "string" ? data : JSON.stringify(data) };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const CRAWL_ID = "22222222-2222-2222-2222-222222222222";

function crawl(overrides: Partial<Crawl> = {}): Crawl {
  return {
    id: CRAWL_ID,
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

function page(overrides: Partial<PageSnapshotSummary> = {}): PageSnapshotSummary {
  return {
    id: "55555555-5555-5555-5555-555555555555",
    pageId: "66666666-6666-6666-6666-666666666666",
    url: "https://example.com/pricing",
    title: "Pricing",
    httpStatus: 200,
    changed: false,
    wordCount: 812,
    qualityScore: 74,
    fetchedAt: new Date().toISOString(),
    ...overrides,
  };
}

const EMPTY_PAGES: Page<PageSnapshotSummary> = { data: [], nextCursor: null };

function renderDetail(crawlOverrides: Partial<Crawl> = {}, pages: Page<PageSnapshotSummary> = EMPTY_PAGES) {
  const initialCrawl = crawl(crawlOverrides);
  return {
    crawl: initialCrawl,
    ...renderWithQueryClient(
      <CrawlDetailView
        projectId={PROJECT_ID}
        crawlId={CRAWL_ID}
        initialCrawl={initialCrawl}
        initialPages={pages}
      />,
    ),
  };
}

/**
 * A `done`/`error` SSE frame invalidates both the crawl and crawl-pages queries at once
 * (`crawl-detail-view.tsx`'s `finish()`), so any test that emits one needs `apiFetch` to return
 * the right shape for whichever endpoint TanStack Query refetches, not a single fixed value.
 */
function stubApiFetchByUrl(crawlResult: Crawl, pagesResult: Page<PageSnapshotSummary> = EMPTY_PAGES) {
  vi.mocked(apiFetch).mockImplementation(
    (async (path: string) => (path.includes("/pages") ? pagesResult : crawlResult)) as typeof apiFetch,
  );
}

describe("CrawlDetailView", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    vi.mocked(apiFetch).mockReset();
    toastError.mockReset();
    FakeEventSource.instances = [];
    vi.unstubAllGlobals();
  });

  it("renders status, trigger, and stat tiles for a finished crawl", () => {
    renderDetail({
      status: "COMPLETED",
      stats: { pagesDiscovered: 40, pagesCrawled: 38, pagesChanged: 3, pagesFailed: 1 },
    });

    expect(screen.getByText("COMPLETED")).toBeInTheDocument();
    // The trigger renders inline as part of a compound caption ("Manual · queued … · finished
    // …"), not as its own element, so this has to match a substring rather than exact text.
    expect(screen.getByText(/Manual/)).toBeInTheDocument();
    expect(screen.getByText("40")).toBeInTheDocument();
    expect(screen.getByText("38")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.queryByText(/degraded during this crawl/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a degradation banner when the crawl finished degraded, and hides it otherwise", () => {
    renderDetail({ status: "COMPLETED_DEGRADED", degradation: { "provider:gemini": true } });
    expect(screen.getByText(/degraded during this crawl/i)).toBeInTheDocument();
  });

  it("does not render a degradation banner when degradation is null", () => {
    renderDetail({ status: "COMPLETED", degradation: null });
    expect(screen.queryByText(/degraded during this crawl/i)).not.toBeInTheDocument();
  });

  it("surfaces the error reason in a destructive alert when present", () => {
    renderDetail({ status: "FAILED", errorReason: "Robots.txt disallowed the crawler." });
    expect(screen.getByRole("alert")).toHaveTextContent("Robots.txt disallowed the crawler.");
  });

  it("renders no alert when errorReason is null", () => {
    renderDetail({ status: "COMPLETED", errorReason: null });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each<CrawlStatus>(["QUEUED", "CRAWLING", "ANALYZING"])(
    "shows a cancel button for the in-flight status %s",
    (status) => {
      renderDetail({ status, finishedAt: null });
      expect(screen.getByRole("button", { name: /cancel crawl/i })).toBeInTheDocument();
    },
  );

  it.each<CrawlStatus>(["COMPLETED", "COMPLETED_DEGRADED", "FAILED", "CANCELED"])(
    "hides the cancel button for the terminal status %s",
    (status) => {
      renderDetail({ status });
      expect(screen.queryByRole("button", { name: /cancel crawl/i })).not.toBeInTheDocument();
    },
  );

  it("cancels an in-flight crawl", async () => {
    vi.mocked(apiFetch).mockResolvedValue(crawl({ status: "CANCELED" }));
    const user = userEvent.setup();
    renderDetail({ status: "CRAWLING", finishedAt: null });

    await user.click(screen.getByRole("button", { name: /cancel crawl/i }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        `/v1/projects/${PROJECT_ID}/crawls/${CRAWL_ID}/cancel`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("surfaces a cancel failure as a toast instead of crashing", async () => {
    vi.mocked(apiFetch).mockRejectedValue(
      new ApiError({
        type: "https://api.geolens.example/errors/validation-failed",
        code: "VALIDATION_FAILED",
        title: "Validation failed",
        status: 400,
        detail: "This crawl can no longer be cancelled.",
      }),
    );
    const user = userEvent.setup();
    renderDetail({ status: "CRAWLING", finishedAt: null });

    await user.click(screen.getByRole("button", { name: /cancel crawl/i }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("This crawl can no longer be cancelled."),
    );
  });

  it("does not open an SSE connection once the crawl has finished", () => {
    renderDetail({ status: "COMPLETED" });
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("opens a credentialed SSE connection and renders live stage/progress frames while in flight", async () => {
    renderDetail({ status: "CRAWLING", finishedAt: null });

    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe(
      `${API_BASE_URL}/v1/projects/${PROJECT_ID}/crawls/${CRAWL_ID}/progress`,
    );
    expect(source.withCredentials).toBe(true);
    expect(screen.getByText("Connecting…")).toBeInTheDocument();

    source.emit("stage", { message: "Discovering pages" });
    expect(await screen.findByText("Discovering pages")).toBeInTheDocument();

    source.emit("progress", {
      pagesFound: 20,
      pagesCrawled: 5,
      currentUrl: "https://example.com/blog/post-1",
      etaSeconds: 45,
    });

    expect(await screen.findByText("5 / 20 pages")).toBeInTheDocument();
    expect(screen.getByText("~45s remaining")).toBeInTheDocument();
    expect(screen.getByText("https://example.com/blog/post-1")).toBeInTheDocument();
  });

  it("closes the SSE connection and refetches the crawl when a 'done' frame arrives", async () => {
    stubApiFetchByUrl(crawl({ status: "COMPLETED" }));
    renderDetail({ status: "CRAWLING", finishedAt: null });
    const source = FakeEventSource.instances[0]!;

    source.emit("done");

    await waitFor(() => expect(source.closed).toBe(true));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(`/v1/projects/${PROJECT_ID}/crawls/${CRAWL_ID}`),
    );
  });

  it("toasts a Problem payload and closes the stream on an SSE error frame", async () => {
    stubApiFetchByUrl(crawl({ status: "FAILED", errorReason: "boom" }));
    renderDetail({ status: "CRAWLING", finishedAt: null });
    const source = FakeEventSource.instances[0]!;

    source.emit("error", {
      code: "CRAWL_STREAM_FAILED",
      title: "Crawl progress stream failed.",
      status: 500,
      detail: "Crawler lost connection to the target site.",
    });

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Crawler lost connection to the target site."),
    );
    expect(source.closed).toBe(true);
  });

  it("ignores a non-Problem 'error' event (the browser's own connection-error event) without toasting", async () => {
    stubApiFetchByUrl(crawl({ status: "FAILED" }));
    renderDetail({ status: "CRAWLING", finishedAt: null });
    const source = FakeEventSource.instances[0]!;

    source.emit("error");

    await waitFor(() => expect(source.closed).toBe(true));
    expect(toastError).not.toHaveBeenCalled();
  });

  it("closes the SSE connection on unmount", () => {
    const { unmount } = renderDetail({ status: "CRAWLING", finishedAt: null });
    const source = FakeEventSource.instances[0]!;

    unmount();

    expect(source.closed).toBe(true);
  });

  it("renders the pages table, treating a null quality score as unsampled rather than zero", () => {
    renderDetail(
      { status: "COMPLETED" },
      {
        data: [
          page({ id: "p1", title: "Pricing", changed: true }),
          page({ id: "p2", title: null, url: "https://example.com/new", qualityScore: null }),
        ],
        nextCursor: null,
      },
    );

    // Scoped to the table: the page also appears in the lens's page picker.
    expect(within(screen.getByRole("table")).getByText("Pricing")).toBeInTheDocument();
    expect(screen.getByText("(untitled)")).toBeInTheDocument();
    expect(screen.getByText("74")).toBeInTheDocument();
    expect(screen.getByText("not in sampled set")).toBeInTheDocument();
    // "Changed" appears three times on purpose: the Stats tile label (crawl.stats.pagesChanged,
    // always rendered), the pages table's column header, and the row badge for the one page
    // that actually changed.
    expect(screen.getAllByText("Changed")).toHaveLength(3);
  });

  it("shows an empty state when there are no pages yet", () => {
    renderDetail({ status: "COMPLETED" }, EMPTY_PAGES);
    expect(screen.getByText("No pages captured yet.")).toBeInTheDocument();
  });

  it("fetches changed-only pages when the filter is toggled", async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      data: [page({ id: "p1", changed: true })],
      nextCursor: null,
    });
    const user = userEvent.setup();
    renderDetail({ status: "COMPLETED" }, EMPTY_PAGES);

    await user.click(screen.getByRole("button", { name: /changed only/i }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        `/v1/projects/${PROJECT_ID}/crawls/${CRAWL_ID}/pages?changed=true`,
      ),
    );
    expect(await screen.findByRole("button", { name: /showing changed only/i })).toBeInTheDocument();
  });
});

describe("CrawlDetailView — through the lens", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.unstubAllGlobals();
  });

  function snapshot(overrides: Partial<PageSnapshotDetail> = {}): PageSnapshotDetail {
    return {
      ...page(),
      hasStructuredData: false,
      internalLinkCount: 3,
      externalLinkCount: 1,
      extracted: { sections: [{ text: "Starter is $9 a month.", headingPath: ["Plans"] }] },
      quality: null,
      carriedForwardFromId: null,
      ...overrides,
    };
  }

  function renderWithLens(citedUrls: string[]) {
    vi.mocked(apiFetch).mockImplementation((async (path: string) =>
      path.includes("/snapshots/") ? snapshot() : { data: [page()], nextCursor: null }) as typeof apiFetch);
    return renderWithQueryClient(
      <CrawlDetailView
        projectId={PROJECT_ID}
        crawlId={CRAWL_ID}
        initialCrawl={crawl({ status: "COMPLETED" })}
        initialPages={{ data: [page()], nextCursor: null }}
        citedUrls={citedUrls}
      />,
    );
  }

  it("shows the first crawled page on the bench, with its real text", async () => {
    renderWithLens([]);

    expect(screen.getByRole("heading", { name: "Through the lens" })).toBeInTheDocument();
    expect((await screen.findAllByText("Starter is $9 a month.")).length).toBeGreaterThan(0);
    expect(screen.getByText(/Not cited\s+◦\s+Quality 74/)).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith(`/v1/projects/${PROJECT_ID}/snapshots/${page().id}`);
  });

  it("renders a page an AI answer cited as cited", async () => {
    renderWithLens(["example.com/pricing"]);

    expect(await screen.findByText(/Cited by AI\s+◦\s+Quality 74/)).toBeInTheDocument();
  });

  it("is absent when the crawl produced no pages", () => {
    renderDetail({ status: "COMPLETED" });
    expect(screen.queryByRole("heading", { name: "Through the lens" })).not.toBeInTheDocument();
  });
});
