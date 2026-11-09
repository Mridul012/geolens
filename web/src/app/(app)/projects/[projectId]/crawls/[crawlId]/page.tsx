import type { Crawl } from "@contracts/api/crawls";
import type { PageSnapshotSummary } from "@contracts/api/snapshots";
import type { Page } from "@contracts/api/common";
import type { PromptResult, PromptRun } from "@contracts/api/prompt-runs";
import { apiFetchServer } from "@/lib/api/server";
import { citedUrls } from "@/lib/evidence";
import { CrawlDetailView } from "./crawl-detail-view";

/** The results API pages at 200; that is every cell of a typical run. */
const CITATION_RESULTS = 200;

export default async function CrawlDetailPage({
  params,
}: PageProps<"/projects/[projectId]/crawls/[crawlId]">) {
  const { projectId, crawlId } = await params;
  const [crawl, pages, runs] = await Promise.all([
    apiFetchServer<Crawl>(`/v1/projects/${projectId}/crawls/${crawlId}`),
    apiFetchServer<Page<PageSnapshotSummary>>(
      `/v1/projects/${projectId}/crawls/${crawlId}/pages`,
    ),
    apiFetchServer<{ data: PromptRun[] }>(`/v1/projects/${projectId}/prompt-runs?limit=1`),
  ]);

  // Which pages AI answers actually cited — the lens renders those sharp. A failed read only
  // means nothing is shown as cited, which the lens's copy already allows for.
  const latestRun = runs.data[0] ?? null;
  const results = latestRun
    ? await apiFetchServer<{ data: PromptResult[] }>(
        `/v1/projects/${projectId}/prompt-runs/${latestRun.id}/results?limit=${CITATION_RESULTS}`,
      )
        .then((page) => page.data)
        .catch(() => [] as PromptResult[])
    : [];

  return (
    <CrawlDetailView
      projectId={projectId}
      crawlId={crawlId}
      initialCrawl={crawl}
      initialPages={pages}
      citedUrls={citedUrls(results)}
    />
  );
}
