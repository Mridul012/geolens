import type { Project } from "@contracts/api/projects";
import { apiFetchServer } from "@/lib/api/server";
import { SignOutButton } from "@/components/sign-out-button";
import { Wordmark } from "@/components/brand-mark";
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
        <Wordmark />
        <div className="ml-auto">
          <SignOutButton withLabel />
        </div>
      </div>

      <ProjectsView initialProjects={projects.data} />
    </div>
  );
}
