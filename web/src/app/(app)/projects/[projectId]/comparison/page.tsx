import Link from "next/link";
import type { Comparison } from "@contracts/api/comparison";
import { apiFetchServer } from "@/lib/api/server";
import { ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { ComparisonView } from "./comparison-view";

export default async function ProjectComparisonPage({
  params,
}: PageProps<"/projects/[projectId]/comparison">) {
  const { projectId } = await params;

  let comparison: Comparison;
  try {
    comparison = await apiFetchServer<Comparison>(`/v1/projects/${projectId}/comparison`);
  } catch (error) {
    // Comparison is a paid-plan feature (config/plans.ts) — a FREE-plan project gets a
    // 403 here, which is an expected entitlement state, not a failure. Server Components
    // don't render anything for an uncaught rejection (Next.js's generic error boundary
    // takes over instead), so this has to be caught here rather than left to propagate.
    if (error instanceof ApiError && error.problem.code === "PLAN_LIMIT_EXCEEDED") {
      return (
        <div className="flex flex-col gap-6 p-10">
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">Comparison</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              See how you stack up against your competitor.
            </p>
          </div>
          <div className="rounded-2xl border-2 border-dashed border-border bg-secondary/40 p-8 text-center">
            <p className="text-lg font-bold">Comparison is a Pro feature</p>
            <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
              {error.problem.detail ?? "Upgrade to compare your site against a competitor."}
            </p>
            <Button
              className="mt-5"
              render={<Link href={`/projects/${projectId}/billing`} />}
              nativeButton={false}
            >
              Upgrade to Pro →
            </Button>
          </div>
        </div>
      );
    }
    throw error;
  }

  return <ComparisonView projectId={projectId} initialComparison={comparison} />;
}
