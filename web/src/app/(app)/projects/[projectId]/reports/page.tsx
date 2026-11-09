import { apiFetchServer } from "@/lib/api/server";
import { ReportsView, type ReportsPage } from "./reports-view";

export default async function ProjectReportsPage({
  params,
}: PageProps<"/projects/[projectId]/reports">) {
  const { projectId } = await params;
  const reports = await apiFetchServer<ReportsPage>(
    `/v1/projects/${projectId}/reports?limit=20`,
  );

  return <ReportsView projectId={projectId} initialReports={reports} />;
}
