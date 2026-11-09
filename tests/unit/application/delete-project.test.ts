/**
 * Deleting a project must schedule its purge — the acceptance criterion the e2e cannot see,
 * because the queue lives outside the HTTP request.
 */
import { describe, expect, it } from "vitest";
import { deleteProject } from "../../../src/application/projects/delete-project.js";
import type { ProjectsRepo } from "../../../src/infrastructure/db/repositories/projects.repo.js";
import type { Project } from "../../../src/contracts/api/projects.js";

const project: Project = {
  id: "01a05108-0000-7000-8000-00000000abcd",
  name: "Acme",
  status: "ACTIVE",
  timezone: "UTC",
  createdAt: new Date().toISOString(),
  sites: [],
};

/** Fake at the port-shaped seam: values in, values out, no database. */
function fakeProjectsRepo(owned: Project | null): {
  repo: ProjectsRepo;
  softDeleted: string[];
} {
  const softDeleted: string[] = [];
  const repo = {
    findOwned: async () => owned,
    softDelete: async (projectId: string) => {
      softDeleted.push(projectId);
    },
  } as unknown as ProjectsRepo;
  return { repo, softDeleted };
}

const clock = { now: () => new Date("2026-08-30T00:00:00.000Z") };

describe("deleteProject", () => {
  it("soft-deletes and schedules the purge", async () => {
    const { repo, softDeleted } = fakeProjectsRepo(project);
    const scheduled: string[] = [];

    const result = await deleteProject(
      { projects: repo, clock, schedulePurge: async (id) => void scheduled.push(id) },
      project.id,
      "user-1",
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ status: "PURGE_SCHEDULED" });
    expect(softDeleted).toEqual([project.id]);
    expect(scheduled).toEqual([project.id]);
  });

  it("returns NOT_FOUND and touches nothing when the project is not the caller's", async () => {
    const { repo, softDeleted } = fakeProjectsRepo(null);
    const scheduled: string[] = [];

    const result = await deleteProject(
      { projects: repo, clock, schedulePurge: async (id) => void scheduled.push(id) },
      project.id,
      "stranger",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    expect(softDeleted).toEqual([]);
    expect(scheduled).toEqual([]);
  });

  it("still soft-deletes when no purge scheduler is wired", async () => {
    const { repo, softDeleted } = fakeProjectsRepo(project);

    const result = await deleteProject({ projects: repo, clock }, project.id, "user-1");

    expect(result.ok).toBe(true);
    expect(softDeleted).toEqual([project.id]);
  });
});
