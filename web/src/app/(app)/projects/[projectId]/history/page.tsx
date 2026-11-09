import { apiFetchServer } from "@/lib/api/server";
import { HISTORY_PAGE_SIZE, type EventPage } from "@/lib/api/events";
import { HistoryView } from "./history-view";

export default async function ProjectHistoryPage({
  params,
}: PageProps<"/projects/[projectId]/history">) {
  const { projectId } = await params;
  const firstPage = await apiFetchServer<EventPage>(
    `/v1/projects/${projectId}/events?limit=${HISTORY_PAGE_SIZE}`,
  );

  return <HistoryView projectId={projectId} initialPage={firstPage} />;
}
