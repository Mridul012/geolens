import type { AnalysisReport } from "@contracts/api/analysis";
import type { Dashboard } from "@contracts/api/dashboard";
import type { ProjectDetail } from "@contracts/api/projects";
import type { PromptResult, PromptRun } from "@contracts/api/prompt-runs";
import { apiFetchServer } from "@/lib/api/server";
import { pickSampleAnswer } from "@/lib/evidence";
import { DashboardView } from "./dashboard-view";

/** Enough answers to find one that cites or mentions the brand; the chart shows just one. */
const SAMPLE_RESULTS = 50;

export default async function ProjectDashboardPage({
  params,
}: PageProps<"/projects/[projectId]">) {
  const { projectId } = await params;
  const base = `/v1/projects/${projectId}`;
  const [dashboard, project, runs] = await Promise.all([
    apiFetchServer<Dashboard>(`${base}/dashboard`),
    apiFetchServer<ProjectDetail>(base),
    apiFetchServer<{ data: PromptRun[] }>(`${base}/prompt-runs?limit=1`),
  ]);

  const crawl = dashboard.crawlStatus;
  const crawlDone =
    crawl !== null && (crawl.status === "COMPLETED" || crawl.status === "COMPLETED_DEGRADED");
  const latestRun = runs.data[0] ?? null;

  // The evidence lines are additions to the dashboard, not its spine: if either read fails the
  // chart still renders, with those lines in their "not measured yet" state.
  const [analysis, results] = await Promise.all([
    crawl && crawlDone
      ? apiFetchServer<AnalysisReport>(`${base}/crawls/${crawl.id}/analysis`).catch(() => null)
      : Promise.resolve(null),
    latestRun
      ? apiFetchServer<{ data: PromptResult[] }>(
          `${base}/prompt-runs/${latestRun.id}/results?limit=${SAMPLE_RESULTS}`,
        )
          .then((page) => page.data)
          .catch(() => [] as PromptResult[])
      : Promise.resolve([] as PromptResult[]),
  ]);

  const ownSite = project.sites.find((site) => site.role === "OWN") ?? null;

  return (
    <DashboardView
      projectId={projectId}
      domain={ownSite?.domain ?? null}
      initialDashboard={dashboard}
      evidence={{
        access: analysis?.accessCheck ?? null,
        retrievability: analysis?.retrievability ?? null,
        sampleAnswer: pickSampleAnswer(results),
      }}
    />
  );
}
