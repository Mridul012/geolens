import type { ProjectDetail } from "@contracts/api/projects";
import type { Me } from "@contracts/api/auth";
import { apiFetchServer } from "@/lib/api/server";
import { Sidebar } from "@/components/sidebar";

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
    <div className="flex min-h-screen">
      <Sidebar project={project} me={me} />
      <main className="flex-1 overflow-x-hidden">{children}</main>
    </div>
  );
}
