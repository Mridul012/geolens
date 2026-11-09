import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EventPayload } from "@contracts/api/snapshots";
import {
  HistoryView,
  describeEvent,
} from "@/app/(app)/projects/[projectId]/history/history-view";
import { apiFetch } from "@/lib/api/client";
import type { EventPage } from "@/lib/api/events";
import { readHistorySeen } from "@/lib/history-seen";
import { renderWithQueryClient, stubLocalStorage } from "../test-utils";

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const CRAWL_ID = "44444444-4444-4444-4444-444444444444";

let nextId = 1;
function event(kind: string, payload: Record<string, unknown>, overrides: Partial<EventPayload> = {}) {
  const value: EventPayload = {
    id: String(nextId++),
    kind,
    payload,
    crawlId: null,
    promptRunId: null,
    createdAt: "2026-11-09T10:00:00.000Z",
    ...overrides,
  };
  return value;
}

function page(data: EventPayload[], nextCursor: string | null = null): EventPage {
  return { data, nextCursor };
}

describe("HistoryView", () => {
  beforeEach(() => {
    stubLocalStorage();
  });

  afterEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it("explains what will appear when nothing has happened yet", () => {
    renderWithQueryClient(<HistoryView projectId={PROJECT_ID} initialPage={page([])} />);
    expect(screen.getByText(/run your first crawl/i)).toBeInTheDocument();
  });

  it("marks History as seen on this device when opened", () => {
    renderWithQueryClient(<HistoryView projectId={PROJECT_ID} initialPage={page([])} />);
    expect(readHistorySeen(PROJECT_ID)).not.toBeNull();
  });

  it("links a crawl event to that crawl", () => {
    renderWithQueryClient(
      <HistoryView
        projectId={PROJECT_ID}
        initialPage={page([
          event(
            "crawl_completed",
            { pagesCrawled: 24, pagesChanged: 3, pagesFailed: 1, status: "COMPLETED" },
            { crawlId: CRAWL_ID },
          ),
        ])}
      />,
    );

    expect(screen.getByRole("link", { name: /crawl finished/i })).toHaveAttribute(
      "href",
      `/projects/${PROJECT_ID}/crawls/${CRAWL_ID}`,
    );
    expect(screen.getByText("24 pages crawled · 3 changed · 1 failed")).toBeInTheDocument();
  });

  it("loads older events with the cursor the API returned", async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      page([event("crawl_failed", { reason: "no_pages_readable" })]),
    );
    const user = userEvent.setup();
    renderWithQueryClient(
      <HistoryView
        projectId={PROJECT_ID}
        initialPage={page([event("score_changed", { composite: 61 })], "cursor-20")}
      />,
    );

    await user.click(screen.getByRole("button", { name: /load older events/i }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        `/v1/projects/${PROJECT_ID}/events?limit=20&cursor=cursor-20`,
      ),
    );
    expect(await screen.findByText("None of your pages could be read.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /load older events/i })).not.toBeInTheDocument();
  });
});

describe("describeEvent", () => {
  const describe_ = (e: EventPayload) => describeEvent(e, PROJECT_ID);

  it("flags a degraded crawl rather than calling it a clean finish", () => {
    expect(describe_(event("crawl_completed", { status: "COMPLETED_DEGRADED" })).title).toBe(
      "Crawl finished with gaps",
    );
  });

  it("says a score was not published instead of showing a number", () => {
    const described = describe_(event("score_changed", { composite: null }));
    expect(described.title).toMatch(/not published/i);
  });

  it("attributes a prompt-run score change to the prompt run", () => {
    const described = describe_(event("score_changed", { composite: 72.4, promptRunId: "r1" }));
    expect(described.title).toBe("Score updated to 72");
    expect(described.detail).toBe("After a prompt run");
    expect(described.href).toBe(`/projects/${PROJECT_ID}/prompts`);
  });

  it("names the blocked AI crawlers and points at the fix", () => {
    const described = describe_(
      event("ai_crawler_blocked", {
        bots: [
          { bot: "GPTBot", blockedBy: "robots" },
          { bot: "ClaudeBot", blockedBy: "cdn" },
        ],
      }),
    );
    expect(described.title).toBe("GPTBot, ClaudeBot are blocked from your site");
    expect(described.href).toBe(`/projects/${PROJECT_ID}/crawler-access`);
    expect(described.tone).toBe("bad");
  });

  it("celebrates crawlers that can read the site again", () => {
    const described = describe_(event("ai_crawler_unblocked", { bots: ["PerplexityBot"] }));
    expect(described.title).toBe("PerplexityBot can read your site again");
    expect(described.tone).toBe("good");
  });

  it("describes a first citation measurement as a measurement, not a jump", () => {
    const described = describe_(event("citation_gained", { from: null, to: 40 }));
    expect(described.detail).toBe("Citation score first measured at 40");
  });

  it("describes a citation loss with both values", () => {
    const described = describe_(event("citation_lost", { from: 55, to: 30 }));
    expect(described.title).toBe("Cited less by AI engines");
    expect(described.detail).toBe("Citation score fell from 55 to 30");
  });

  it("summarises a finished prompt run", () => {
    const described = describe_(
      event("prompt_run_completed", { mentionRate: 62.5, citationShare: 20 }),
    );
    expect(described.detail).toBe("Mentioned in 63% of answers · cited in 20%");
  });

  it("still shows a kind it has no copy for, instead of hiding it", () => {
    expect(describe_(event("pages_stale", {})).title).toBe("Pages stale");
  });

  it("ignores malformed payload fields rather than printing them", () => {
    const described = describe_(event("crawl_completed", { pagesCrawled: "lots" }));
    expect(described.detail).toBeNull();
  });
});
