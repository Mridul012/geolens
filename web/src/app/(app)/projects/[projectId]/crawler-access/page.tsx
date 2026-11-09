import type { ProjectDetail } from "@contracts/api/projects";
import type { AnalysisReport } from "@contracts/api/analysis";
import type { CrawlStatus } from "@contracts/api/crawls";
import { apiFetchServer } from "@/lib/api/server";
import { CrawlerAccessView } from "./crawler-access-view";

const READY_STATUSES: CrawlStatus[] = ["COMPLETED", "COMPLETED_DEGRADED"];

export default async function CrawlerAccessPage({
  params,
}: PageProps<"/projects/[projectId]/crawler-access">) {
  const { projectId } = await params;
  const project = await apiFetchServer<ProjectDetail>(`/v1/projects/${projectId}`);

  const latestCrawl = project.latestCrawl;
  const isReady = latestCrawl !== null && READY_STATUSES.includes(latestCrawl.status);

  // Only fetch the (heavier) analysis report once the latest crawl has actually finished —
  // the API returns 409 for a crawl that hasn't completed, and there's nothing to show yet
  // anyway. The view renders an honest empty/in-progress state client-side for every other
  // status (docs/Frontend-Design.md §6.4 — AI Crawler Access panel).
  const analysis = isReady
    ? await apiFetchServer<AnalysisReport>(
        `/v1/projects/${projectId}/crawls/${latestCrawl.id}/analysis`,
      )
    : null;

  return (
    <CrawlerAccessView
      projectId={projectId}
      initialProject={project}
      initialAccessCheck={analysis?.accessCheck ?? null}
    />
  );
}
