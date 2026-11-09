import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProjectDetail } from "@contracts/api/projects";
import type { Me } from "@contracts/api/auth";
import { ProjectHeader } from "@/components/project-header";
import { apiFetch, ApiError } from "@/lib/api/client";
import { markHistorySeen } from "@/lib/history-seen";
import { renderWithQueryClient, stubLocalStorage } from "../test-utils";

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const replace = vi.fn();
const refresh = vi.fn();
let pathname = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh, push: vi.fn() }),
  usePathname: () => pathname,
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";

const project: ProjectDetail = {
  id: PROJECT_ID,
  name: "Acme",
  status: "ACTIVE",
  timezone: "UTC",
  createdAt: "2026-11-01T00:00:00.000Z",
  sites: [],
  latestCrawl: null,
  latestScore: null,
};

const counter = { used: 0, limit: 1 };
const me: Me = {
  id: "22222222-2222-2222-2222-222222222222",
  email: "priya@acme.com",
  name: "Priya",
  plan: "FREE",
  usage: { projects: counter, activePrompts: counter, onDemandRunsThisWeek: counter },
};

const CRAWL_DONE_AT = "2026-11-09T10:00:00.000Z";

function eventsWithCrawlAt(createdAt: string | null) {
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (String(path).includes("kind=crawl_completed") && createdAt !== null) {
      return {
        data: [
          {
            id: "1",
            kind: "crawl_completed",
            payload: {},
            crawlId: null,
            promptRunId: null,
            createdAt,
          },
        ],
        nextCursor: null,
      };
    }
    return { data: [], nextCursor: null };
  });
}

function unauthorized() {
  return new ApiError({
    type: "https://api.geolens.example/errors/auth-required",
    title: "Authentication required",
    status: 401,
    code: "AUTH_REQUIRED",
  });
}

describe("ProjectHeader", () => {
  beforeEach(() => {
    pathname = `/projects/${PROJECT_ID}`;
    stubLocalStorage();
  });

  afterEach(() => {
    vi.mocked(apiFetch).mockReset();
    replace.mockReset();
    refresh.mockReset();
    toastError.mockReset();
  });

  it("links to History and Settings for the project", () => {
    eventsWithCrawlAt(null);
    renderWithQueryClient(<ProjectHeader project={project} me={me} />);

    expect(screen.getByRole("link", { name: /history/i })).toHaveAttribute(
      "href",
      `/projects/${PROJECT_ID}/history`,
    );
    expect(screen.getByRole("link", { name: /settings/i })).toHaveAttribute(
      "href",
      `/projects/${PROJECT_ID}/settings`,
    );
  });

  describe("sign-out", () => {
    it("ends the session, clears cached data and returns to sign-in", async () => {
      eventsWithCrawlAt(null);
      const user = userEvent.setup();
      const { queryClient } = renderWithQueryClient(<ProjectHeader project={project} me={me} />);
      queryClient.setQueryData(["dashboard", PROJECT_ID], { secret: true });

      await user.click(screen.getByRole("button", { name: /sign out/i }));

      await waitFor(() => expect(replace).toHaveBeenCalledWith("/sign-in"));
      expect(apiFetch).toHaveBeenCalledWith("/v1/auth/sign-out", { method: "POST" });
      expect(queryClient.getQueryData(["dashboard", PROJECT_ID])).toBeUndefined();
      expect(refresh).toHaveBeenCalled();
    });

    it("still leaves when the session had already expired", async () => {
      eventsWithCrawlAt(null);
      const user = userEvent.setup();
      renderWithQueryClient(<ProjectHeader project={project} me={me} />);
      vi.mocked(apiFetch).mockRejectedValueOnce(unauthorized());

      await user.click(screen.getByRole("button", { name: /sign out/i }));

      await waitFor(() => expect(replace).toHaveBeenCalledWith("/sign-in"));
      expect(toastError).not.toHaveBeenCalled();
    });

    it("stays put and says so when sign-out fails for another reason", async () => {
      eventsWithCrawlAt(null);
      const user = userEvent.setup();
      renderWithQueryClient(<ProjectHeader project={project} me={me} />);
      vi.mocked(apiFetch).mockRejectedValueOnce(new Error("network down"));

      await user.click(screen.getByRole("button", { name: /sign out/i }));

      await waitFor(() => expect(toastError).toHaveBeenCalled());
      expect(replace).not.toHaveBeenCalled();
    });
  });

  describe("new crawl results dot", () => {
    it("shows when a crawl finished and History was never opened here", async () => {
      eventsWithCrawlAt(CRAWL_DONE_AT);
      renderWithQueryClient(<ProjectHeader project={project} me={me} />);

      expect(await screen.findByLabelText("New crawl results")).toBeInTheDocument();
    });

    it("clears once History is visited after that crawl", async () => {
      eventsWithCrawlAt(CRAWL_DONE_AT);
      renderWithQueryClient(<ProjectHeader project={project} me={me} />);
      await screen.findByLabelText("New crawl results");

      act(() => markHistorySeen(PROJECT_ID, Date.parse(CRAWL_DONE_AT) + 1));

      await waitFor(() =>
        expect(screen.queryByLabelText("New crawl results")).not.toBeInTheDocument(),
      );
    });

    it("does not show for a crawl older than the last visit", async () => {
      markHistorySeen(PROJECT_ID, Date.parse(CRAWL_DONE_AT) + 60_000);
      eventsWithCrawlAt(CRAWL_DONE_AT);
      renderWithQueryClient(<ProjectHeader project={project} me={me} />);

      await waitFor(() => expect(apiFetch).toHaveBeenCalled());
      expect(screen.queryByLabelText("New crawl results")).not.toBeInTheDocument();
    });

    it("does not show while History itself is open", async () => {
      pathname = `/projects/${PROJECT_ID}/history`;
      eventsWithCrawlAt(CRAWL_DONE_AT);
      renderWithQueryClient(<ProjectHeader project={project} me={me} />);

      await waitFor(() => expect(apiFetch).toHaveBeenCalled());
      expect(screen.queryByLabelText("New crawl results")).not.toBeInTheDocument();
    });

    it("stays hidden when there has never been a crawl", async () => {
      eventsWithCrawlAt(null);
      renderWithQueryClient(<ProjectHeader project={project} me={me} />);

      await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
      expect(screen.queryByLabelText("New crawl results")).not.toBeInTheDocument();
    });
  });

  describe("focus strip", () => {
    const withSite: ProjectDetail = {
      ...project,
      sites: [
        {
          id: "33333333-3333-3333-3333-333333333333",
          url: "https://acme.example/",
          domain: "acme.example",
          role: "OWN",
          name: null,
        },
      ],
    };

    it("is hidden on the dashboard, where the full-size hero takes its place", () => {
      eventsWithCrawlAt(null);
      renderWithQueryClient(<ProjectHeader project={withSite} me={me} />);

      expect(screen.queryByRole("link", { name: /ai visibility/i })).not.toBeInTheDocument();
    });

    it("keeps the site's measured visibility in view on every other page", () => {
      pathname = `/projects/${PROJECT_ID}/topics`;
      eventsWithCrawlAt(null);
      const scored: ProjectDetail = {
        ...withSite,
        latestScore: {
          id: "44444444-4444-4444-4444-444444444444",
          composite: 42,
          scoreCitation: null,
          scoreRetrievability: null,
          scoreContentQuality: null,
          scoreTopicCoverage: null,
          scoreTechnical: null,
          scoreTrust: null,
          crawlId: null,
          promptRunId: null,
          scoringConfigVersion: "scoring.v1",
          createdAt: "2026-11-09T10:00:00.000Z",
        },
      };
      renderWithQueryClient(<ProjectHeader project={scored} me={me} />);

      const strip = screen.getByRole("link", { name: /ai visibility 42 out of 100/i });
      expect(strip).toHaveAttribute("href", `/projects/${PROJECT_ID}`);
      expect(strip).toHaveAccessibleName(/acme\.example/);
    });

    it("says 'not measured' rather than showing a score of 0", () => {
      pathname = `/projects/${PROJECT_ID}/topics`;
      eventsWithCrawlAt(null);
      renderWithQueryClient(<ProjectHeader project={withSite} me={me} />);

      expect(
        screen.getByRole("link", { name: /ai visibility not yet measured/i }),
      ).toBeInTheDocument();
      expect(screen.queryByText("0")).not.toBeInTheDocument();
    });
  });
});
