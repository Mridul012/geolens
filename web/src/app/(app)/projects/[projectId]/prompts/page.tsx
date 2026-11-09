import type { PromptTemplate } from "@contracts/api/prompts";
import type { PromptRun, PromptRunTrend } from "@contracts/api/prompt-runs";
import { apiFetchServer } from "@/lib/api/server";
import { PromptsView } from "./prompts-view";

interface PromptListPage {
  readonly data: PromptTemplate[];
}

interface PromptRunListPage {
  readonly data: PromptRun[];
  readonly nextCursor: string | null;
}

export default async function PromptsPage({
  params,
}: PageProps<"/projects/[projectId]/prompts">) {
  const { projectId } = await params;
  const [prompts, runs, trend] = await Promise.all([
    apiFetchServer<PromptListPage>(`/v1/projects/${projectId}/prompts`),
    apiFetchServer<PromptRunListPage>(`/v1/projects/${projectId}/prompt-runs?limit=10`),
    apiFetchServer<PromptRunTrend>(`/v1/projects/${projectId}/prompt-runs/trend`),
  ]);

  return (
    <PromptsView
      projectId={projectId}
      initialPrompts={prompts.data}
      initialRuns={runs.data}
      initialRunsNextCursor={runs.nextCursor}
      initialTrend={trend.data}
    />
  );
}
