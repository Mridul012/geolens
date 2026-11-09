import type { ProjectDetail, Site } from "@contracts/api/projects";
import { apiFetchServer } from "@/lib/api/server";
import { SettingsView } from "./settings-view";

export default async function ProjectSettingsPage({
  params,
}: PageProps<"/projects/[projectId]/settings">) {
  const { projectId } = await params;
  const [project, competitors] = await Promise.all([
    apiFetchServer<ProjectDetail>(`/v1/projects/${projectId}`),
    apiFetchServer<{ data: Site[] }>(`/v1/projects/${projectId}/competitors`),
  ]);

  return <SettingsView project={project} initialCompetitors={competitors.data} />;
}
