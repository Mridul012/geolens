import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Problem } from "@contracts/api/errors";
import type { ProjectDetail, Site } from "@contracts/api/projects";
import { SettingsView } from "@/app/(app)/projects/[projectId]/settings/settings-view";
import { apiFetch, ApiError } from "@/lib/api/client";
import { renderWithQueryClient } from "../test-utils";

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const replace = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh, push: vi.fn() }),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

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

const rival: Site = {
  id: "33333333-3333-3333-3333-333333333333",
  url: "https://rival.com/",
  domain: "rival.com",
  role: "COMPETITOR",
  name: "Rival",
};

function problem(code: Problem["code"], status: number, extra: Partial<Problem> = {}): ApiError {
  return new ApiError({
    type: `https://api.geolens.example/errors/${code.toLowerCase()}`,
    title: code,
    status,
    code,
    ...extra,
  });
}

function renderSettings(competitors: Site[] = []) {
  return renderWithQueryClient(
    <SettingsView project={project} initialCompetitors={competitors} />,
  );
}

describe("SettingsView", () => {
  afterEach(() => {
    vi.mocked(apiFetch).mockReset();
    replace.mockReset();
    refresh.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  describe("general", () => {
    it("keeps Save disabled until something changes", () => {
      renderSettings();
      expect(screen.getByRole("button", { name: /save changes/i })).toBeDisabled();
    });

    it("sends only the fields that changed", async () => {
      vi.mocked(apiFetch).mockResolvedValue({ ...project, name: "Acme Inc" });
      const user = userEvent.setup();
      renderSettings();

      const name = screen.getByLabelText(/project name/i);
      await user.clear(name);
      await user.type(name, "Acme Inc");
      await user.click(screen.getByRole("button", { name: /save changes/i }));

      await waitFor(() =>
        expect(apiFetch).toHaveBeenCalledWith(`/v1/projects/${PROJECT_ID}`, {
          method: "PATCH",
          body: { name: "Acme Inc" },
        }),
      );
      expect(toastSuccess).toHaveBeenCalledWith("Project updated");
      expect(refresh).toHaveBeenCalled();
    });

    it("blocks an empty name with the contract's own rule, without calling the API", async () => {
      const user = userEvent.setup();
      renderSettings();

      await user.clear(screen.getByLabelText(/project name/i));
      await user.click(screen.getByRole("button", { name: /save changes/i }));

      expect(apiFetch).not.toHaveBeenCalled();
    });

    it("shows the API's reason when the update is rejected", async () => {
      vi.mocked(apiFetch).mockRejectedValue(
        problem("VALIDATION_FAILED", 400, {
          errors: [{ path: "timezone", message: "Unknown timezone." }],
        }),
      );
      const user = userEvent.setup();
      renderSettings();

      const timezone = screen.getByLabelText(/timezone/i);
      await user.clear(timezone);
      await user.type(timezone, "Mars/Olympus");
      await user.click(screen.getByRole("button", { name: /save changes/i }));

      expect(await screen.findByText("Unknown timezone.")).toBeInTheDocument();
    });
  });

  describe("competitor", () => {
    it("shows an empty state with no competitor", () => {
      renderSettings();
      expect(screen.getByText("No competitor yet.")).toBeInTheDocument();
    });

    it("adds a competitor, omitting a blank name", async () => {
      vi.mocked(apiFetch).mockImplementation(async (_path, options) =>
        options?.method === "POST" ? rival : { data: [rival] },
      );
      const user = userEvent.setup();
      renderSettings();

      await user.type(screen.getByLabelText(/competitor url/i), "https://rival.com");
      await user.click(screen.getByRole("button", { name: /add competitor/i }));

      await waitFor(() =>
        expect(apiFetch).toHaveBeenCalledWith(`/v1/projects/${PROJECT_ID}/competitors`, {
          method: "POST",
          body: { url: "https://rival.com" },
        }),
      );
      expect(toastSuccess).toHaveBeenCalledWith("Now comparing against rival.com");
    });

    it("explains the plan limit in plain language", async () => {
      vi.mocked(apiFetch).mockRejectedValue(problem("PLAN_LIMIT_EXCEEDED", 403));
      const user = userEvent.setup();
      renderSettings([rival]);

      await user.type(screen.getByLabelText(/competitor url/i), "https://other.com");
      await user.click(screen.getByRole("button", { name: /add competitor/i }));

      expect(
        await screen.findByText(/your plan allows one competitor per project/i),
      ).toBeInTheDocument();
    });

    it("shows why a URL was rejected", async () => {
      vi.mocked(apiFetch).mockRejectedValue(
        problem("INVALID_URL", 400, { detail: "Private network addresses can't be crawled." }),
      );
      const user = userEvent.setup();
      renderSettings();

      await user.type(screen.getByLabelText(/competitor url/i), "http://10.0.0.1");
      await user.click(screen.getByRole("button", { name: /add competitor/i }));

      expect(
        await screen.findByText("Private network addresses can't be crawled."),
      ).toBeInTheDocument();
    });

    it("removes a competitor", async () => {
      vi.mocked(apiFetch).mockImplementation(async (_path, options) =>
        options?.method === "DELETE" ? undefined : { data: [] },
      );
      const user = userEvent.setup();
      renderSettings([rival]);

      await user.click(screen.getByRole("button", { name: "Remove rival.com" }));

      await waitFor(() =>
        expect(apiFetch).toHaveBeenCalledWith(
          `/v1/projects/${PROJECT_ID}/competitors/${rival.id}`,
          { method: "DELETE" },
        ),
      );
      expect(toastSuccess).toHaveBeenCalledWith("Stopped comparing against rival.com");
    });

    it("says so when a competitor can't be removed", async () => {
      vi.mocked(apiFetch).mockRejectedValue(
        problem("NOT_FOUND", 404, { detail: "Competitor not found." }),
      );
      const user = userEvent.setup();
      renderSettings([rival]);

      await user.click(screen.getByRole("button", { name: "Remove rival.com" }));

      await waitFor(() => expect(toastError).toHaveBeenCalledWith("Competitor not found."));
    });
  });

  describe("delete", () => {
    it("only enables deletion once the exact project name is typed", async () => {
      const user = userEvent.setup();
      renderSettings();

      await user.click(screen.getByRole("button", { name: /delete project/i }));
      const confirm = screen.getByRole("button", { name: /delete forever/i });
      expect(confirm).toBeDisabled();

      await user.type(screen.getByLabelText(/to confirm/i), "acme");
      expect(confirm).toBeDisabled();

      await user.clear(screen.getByLabelText(/to confirm/i));
      await user.type(screen.getByLabelText(/to confirm/i), "Acme");
      expect(confirm).toBeEnabled();
    });

    it("deletes, forgets the project's cached data and returns to the project list", async () => {
      vi.mocked(apiFetch).mockResolvedValue({ status: "PURGE_SCHEDULED" });
      const user = userEvent.setup();
      const { queryClient } = renderSettings();
      queryClient.setQueryData(["dashboard", PROJECT_ID], { cached: true });

      await user.click(screen.getByRole("button", { name: /delete project/i }));
      await user.type(screen.getByLabelText(/to confirm/i), "Acme");
      await user.click(screen.getByRole("button", { name: /delete forever/i }));

      await waitFor(() => expect(replace).toHaveBeenCalledWith("/projects"));
      expect(apiFetch).toHaveBeenCalledWith(`/v1/projects/${PROJECT_ID}`, { method: "DELETE" });
      expect(queryClient.getQueryData(["dashboard", PROJECT_ID])).toBeUndefined();
    });

    it("stays on the page and explains a failed deletion", async () => {
      vi.mocked(apiFetch).mockRejectedValue(
        problem("NOT_FOUND", 404, { detail: "Project not found." }),
      );
      const user = userEvent.setup();
      renderSettings();

      await user.click(screen.getByRole("button", { name: /delete project/i }));
      await user.type(screen.getByLabelText(/to confirm/i), "Acme");
      await user.click(screen.getByRole("button", { name: /delete forever/i }));

      expect(await screen.findByText("Project not found.")).toBeInTheDocument();
      expect(replace).not.toHaveBeenCalled();
    });
  });
});
