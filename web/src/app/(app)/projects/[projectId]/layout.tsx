import type { ProjectDetail } from "@contracts/api/projects";
import type { Me } from "@contracts/api/auth";
import { apiFetchServer } from "@/lib/api/server";
import { ProjectHeader } from "@/components/project-header";

export default async function ProjectLayout({
  children,
  params,
}: LayoutProps<"/projects/[projectId]">) {
  const { projectId } = await params;
  const [project, me] = await Promise.all([
    apiFetchServer<ProjectDetail>(`/v1/projects/${projectId}`),
    apiFetchServer<Me>("/v1/me"),
  ]);

  return (
    <div className="flex min-h-screen flex-col">
      <ProjectHeader project={project} me={me} />
      <main className="mx-auto w-full max-w-[1200px] flex-1">{children}</main>
    </div>
  );
}
