import type { Dashboard } from "@contracts/api/dashboard";
import { apiFetchServer } from "@/lib/api/server";
import { DashboardView } from "./dashboard-view";

export default async function ProjectDashboardPage({
  params,
}: PageProps<"/projects/[projectId]">) {
  const { projectId } = await params;
  const dashboard = await apiFetchServer<Dashboard>(`/v1/projects/${projectId}/dashboard`);

  return <DashboardView projectId={projectId} initialDashboard={dashboard} />;
}
