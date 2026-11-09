import type { Project } from "@contracts/api/projects";
import { apiFetchServer } from "@/lib/api/server";
import { ProjectsView } from "./projects-view";

interface ProjectsPage {
  readonly data: Project[];
  readonly nextCursor: string | null;
}

export default async function ProjectsIndexPage() {
  const projects = await apiFetchServer<ProjectsPage>("/v1/projects");

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-9 px-8 py-14">
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-primary">
          <svg viewBox="0 0 24 24" fill="none" className="h-4.5 w-4.5 text-primary-foreground">
            <path
              d="M4 12L10 18L20 6"
              stroke="currentColor"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <span className="text-lg font-extrabold tracking-tight">GEOlens</span>
      </div>

      <ProjectsView initialProjects={projects.data} />
    </div>
  );
}
