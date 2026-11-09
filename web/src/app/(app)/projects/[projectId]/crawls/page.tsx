import type { Crawl } from "@contracts/api/crawls";
import type { Page } from "@contracts/api/common";
import { apiFetchServer } from "@/lib/api/server";
import { CrawlsView } from "./crawls-view";

export default async function CrawlsPage({
  params,
}: PageProps<"/projects/[projectId]/crawls">) {
  const { projectId } = await params;
  const crawls = await apiFetchServer<Page<Crawl>>(`/v1/projects/${projectId}/crawls`);

  return <CrawlsView projectId={projectId} initialCrawls={crawls} />;
}
