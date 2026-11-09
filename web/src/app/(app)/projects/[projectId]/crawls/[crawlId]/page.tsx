import type { Crawl } from "@contracts/api/crawls";
import type { PageSnapshotSummary } from "@contracts/api/snapshots";
import type { Page } from "@contracts/api/common";
import { apiFetchServer } from "@/lib/api/server";
import { CrawlDetailView } from "./crawl-detail-view";

export default async function CrawlDetailPage({
  params,
}: PageProps<"/projects/[projectId]/crawls/[crawlId]">) {
  const { projectId, crawlId } = await params;
  const [crawl, pages] = await Promise.all([
    apiFetchServer<Crawl>(`/v1/projects/${projectId}/crawls/${crawlId}`),
    apiFetchServer<Page<PageSnapshotSummary>>(
      `/v1/projects/${projectId}/crawls/${crawlId}/pages`,
    ),
  ]);

  return (
    <CrawlDetailView
      projectId={projectId}
      crawlId={crawlId}
      initialCrawl={crawl}
      initialPages={pages}
    />
  );
}
