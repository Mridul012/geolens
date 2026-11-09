import type { Topic } from "@contracts/api/topics";
import type { TopicCoverageResponse } from "@contracts/api/coverage";
import { apiFetchServer } from "@/lib/api/server";
import { TopicsView } from "./topics-view";

interface TopicsListResponse {
  readonly data: Topic[];
}

export default async function TopicsPage({
  params,
}: PageProps<"/projects/[projectId]/topics">) {
  const { projectId } = await params;

  const [topics, coverage] = await Promise.all([
    apiFetchServer<TopicsListResponse>(`/v1/projects/${projectId}/topics`),
    apiFetchServer<TopicCoverageResponse>(`/v1/projects/${projectId}/topics/coverage`),
  ]);

  return (
    <TopicsView projectId={projectId} initialTopics={topics.data} initialCoverage={coverage} />
  );
}
