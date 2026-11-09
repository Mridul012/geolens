import type { Recommendation } from "@contracts/api/recommendations";
import { apiFetchServer } from "@/lib/api/server";
import { RecommendationsView } from "./recommendations-view";

interface RecommendationsPage {
  readonly data: Recommendation[];
  readonly nextCursor: string | null;
}

export default async function ProjectRecommendationsPage({
  params,
}: PageProps<"/projects/[projectId]/recommendations">) {
  const { projectId } = await params;
  const recommendations = await apiFetchServer<RecommendationsPage>(
    `/v1/projects/${projectId}/recommendations?limit=50`,
  );

  return <RecommendationsView projectId={projectId} initialRecommendations={recommendations.data} />;
}
