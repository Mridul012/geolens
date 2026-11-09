import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project } from "@contracts/api/projects";
import { ProjectsView } from "@/app/(app)/projects/projects-view";
import { apiFetch } from "@/lib/api/client";
import { renderWithQueryClient } from "../test-utils";

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

const project = (overrides: Partial<Project> = {}): Project => ({
  id: "11111111-1111-1111-1111-111111111111",
  name: "Acme",
  status: "ACTIVE",
  timezone: "UTC",
  createdAt: new Date().toISOString(),
  sites: [{ id: "s1", url: "https://acme.com", domain: "acme.com", role: "OWN", name: null }],
  ...overrides,
});

describe("ProjectsView", () => {
  afterEach(() => {
    vi.mocked(apiFetch).mockReset();
    push.mockReset();
  });

  it("goes straight to the create form when there are no projects yet", () => {
    renderWithQueryClient(<ProjectsView initialProjects={[]} />);

    expect(screen.getByRole("heading", { name: "Track a new site" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /new project/i })).not.toBeInTheDocument();
  });

  it("lists existing projects and offers a 'New project' tile instead of the form", () => {
    renderWithQueryClient(<ProjectsView initialProjects={[project()]} />);

    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("acme.com")).toBeInTheDocument();
    expect(screen.getByText("no competitor added")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Track a new site" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new project/i })).toBeInTheDocument();
  });

  it("does not submit and shows a field error when the URL is left empty", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<ProjectsView initialProjects={[]} />);

    await user.type(screen.getByLabelText("Project name"), "Acme");
    await user.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() => expect(apiFetch).not.toHaveBeenCalled());
    expect(screen.getByText("String must contain at least 1 character(s)")).toBeInTheDocument();
  });

  it("submits the normalized form and navigates to the new project on success", async () => {
    const created = project({ id: "22222222-2222-2222-2222-222222222222", name: "New Co" });
    // The mutation's POST resolves to the new project; the list invalidation it triggers
    // refetches GET /v1/projects, which must resolve to the paginated shape, not the bare
    // project — conflating the two is exactly what crashed `projects.length` before this.
    vi.mocked(apiFetch).mockImplementation(async (_path, options) =>
      options?.method === "POST" ? created : { data: [created], nextCursor: null },
    );
    const user = userEvent.setup();
    renderWithQueryClient(<ProjectsView initialProjects={[]} />);

    await user.type(screen.getByLabelText("Project name"), "New Co");
    await user.type(screen.getByLabelText("Your website"), "https://newco.com");
    await user.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith("/v1/projects", {
        method: "POST",
        body: {
          name: "New Co",
          url: "https://newco.com",
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      }),
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/projects/${created.id}`));
  });
});
