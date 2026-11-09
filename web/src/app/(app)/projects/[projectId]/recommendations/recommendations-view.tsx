"use client";

import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Recommendation, RecommendationDetail } from "@contracts/api/recommendations";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";

type RecStatus = Recommendation["status"];
type RecPriority = Recommendation["priority"];
type RecSource = Recommendation["source"];

/** The three statuses a client may set — see `updateRecommendationBodySchema`. */
type ClientStatus = "OPEN" | "DONE" | "DISMISSED";

type StatusFilter = RecStatus | "ALL";
type PriorityFilter = RecPriority | "ALL";

interface RecommendationListPage {
  readonly data: Recommendation[];
  readonly nextCursor: string | null;
}

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "ALL", label: "All statuses" },
  { value: "OPEN", label: "Open" },
  { value: "DONE", label: "Done" },
  { value: "DISMISSED", label: "Dismissed" },
  { value: "VALIDATED", label: "Validated" },
  { value: "REGRESSED", label: "Regressed" },
];

const PRIORITY_FILTERS: { value: PriorityFilter; label: string }[] = [
  { value: "ALL", label: "All priorities" },
  { value: "CRITICAL", label: "Critical" },
  { value: "HIGH", label: "High" },
  { value: "MEDIUM", label: "Medium" },
  { value: "LOW", label: "Low" },
];

/**
 * VALIDATED and REGRESSED are pipeline-owned (docs/Frontend-Design.md §9): they must render
 * as visually distinct, non-interactive badges and never appear as something a user can
 * click into to change status.
 */
function isPipelineStatus(status: RecStatus): boolean {
  return status === "VALIDATED" || status === "REGRESSED";
}

function buildListPath(projectId: string, status: StatusFilter, priority: PriorityFilter): string {
  const params = new URLSearchParams({ limit: "50" });
  if (status !== "ALL") params.set("status", status);
  if (priority !== "ALL") params.set("priority", priority);
  return `/v1/projects/${projectId}/recommendations?${params.toString()}`;
}

export function RecommendationsView({
  projectId,
  initialRecommendations,
}: {
  projectId: string;
  initialRecommendations: Recommendation[];
}) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const isDefaultFilter = statusFilter === "ALL" && priorityFilter === "ALL";

  const { data, isLoading } = useQuery({
    queryKey: ["recommendations", projectId, statusFilter, priorityFilter],
    queryFn: () =>
      apiFetch<RecommendationListPage>(buildListPath(projectId, statusFilter, priorityFilter)),
    initialData: isDefaultFilter ? { data: initialRecommendations, nextCursor: null } : undefined,
  });

  const recommendations = data?.data ?? [];

  return (
    <div className="flex flex-col gap-6 p-5 md:p-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-[28px] leading-tight font-extrabold tracking-[-0.02em]">Recommendations</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Fixes ranked by impact vs. difficulty — work the top of the list first.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <Select
            value={statusFilter}
            onValueChange={(value) => setStatusFilter(value as StatusFilter)}
          >
            <SelectTrigger className="w-40" size="sm" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={priorityFilter}
            onValueChange={(value) => setPriorityFilter(value as PriorityFilter)}
          >
            <SelectTrigger className="w-40" size="sm" aria-label="Filter by priority">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRIORITY_FILTERS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading && !data ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-24 w-full rounded-[10px]" />
          ))}
        </div>
      ) : recommendations.length === 0 ? (
        <div className="rounded-[10px] border border-dashed border-input bg-card/60 p-8 text-center">
          <p className="text-lg font-bold">No recommendations match these filters</p>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
            Try a different status or priority, or run a crawl to generate fresh findings.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {recommendations.map((rec) => (
            <RecommendationCard key={rec.id} recommendation={rec} onOpen={() => setSelectedId(rec.id)} />
          ))}
        </div>
      )}

      <Sheet
        open={selectedId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      >
        <SheetContent>
          {selectedId && (
            <RecommendationDetailPanel
              projectId={projectId}
              recId={selectedId}
              onStatusChanged={() =>
                queryClient.invalidateQueries({ queryKey: ["recommendations", projectId] })
              }
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function RecommendationCard({
  recommendation,
  onOpen,
}: {
  recommendation: Recommendation;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex items-center gap-4 panel p-6 text-left transition-colors hover:border-foreground"
    >
      <PriorityBadge priority={recommendation.priority} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{recommendation.title}</div>
        <div className="mt-2 flex items-center gap-4">
          <ScoreBar label="Impact" value={recommendation.impact} />
          <ScoreBar label="Difficulty" value={recommendation.difficulty} />
        </div>
      </div>
      <SourceBadge source={recommendation.source} />
      <StatusBadge status={recommendation.status} />
    </button>
  );
}

function RecommendationDetailPanel({
  projectId,
  recId,
  onStatusChanged,
}: {
  projectId: string;
  recId: string;
  onStatusChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const detailQueryKey = ["recommendation", projectId, recId];

  const { data: detail, isLoading } = useQuery({
    queryKey: detailQueryKey,
    queryFn: () =>
      apiFetch<RecommendationDetail>(`/v1/projects/${projectId}/recommendations/${recId}`),
  });

  const updateStatus = useMutation({
    mutationFn: (status: ClientStatus) =>
      apiFetch<Recommendation>(`/v1/projects/${projectId}/recommendations/${recId}`, {
        method: "PATCH",
        body: { status },
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(detailQueryKey, (previous: RecommendationDetail | undefined) =>
        previous ? { ...previous, ...updated } : previous,
      );
      onStatusChanged();
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });

  if (isLoading || !detail) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
      </div>
    );
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle>{detail.title}</SheetTitle>
        <SheetDescription>
          {detail.ruleKey ? `Rule: ${detail.ruleKey}` : "AI-generated finding"}
        </SheetDescription>
      </SheetHeader>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4">
        <div className="flex flex-wrap items-center gap-2">
          <PriorityBadge priority={detail.priority} />
          <SourceBadge source={detail.source} />
          <StatusBadge status={detail.status} />
        </div>

        <p className="text-sm whitespace-pre-wrap text-foreground">{detail.body}</p>

        <div className="flex gap-4">
          <ScoreBar label="Impact" value={detail.impact} />
          <ScoreBar label="Difficulty" value={detail.difficulty} />
        </div>

        <div>
          <SectionLabel>Evidence</SectionLabel>
          {Object.keys(detail.evidence).length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No evidence recorded.</p>
          ) : (
            <dl className="mt-2 flex flex-col gap-1.5">
              {Object.entries(detail.evidence).map(([key, value]) => (
                <div key={key} className="flex items-start justify-between gap-3 text-xs">
                  <dt className="shrink-0 font-semibold text-muted-foreground">{key}</dt>
                  <dd className="truncate text-right">{formatEvidenceValue(value)}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>

        <div className="grid grid-cols-3 gap-3 text-xs text-muted-foreground">
          <div>
            <SectionLabel>First seen crawl</SectionLabel>
            <p className="mt-1 truncate">{detail.firstSeenCrawlId ?? "—"}</p>
          </div>
          <div>
            <SectionLabel>Last seen crawl</SectionLabel>
            <p className="mt-1 truncate">{detail.lastSeenCrawlId ?? "—"}</p>
          </div>
          <div>
            <SectionLabel>Resolved at</SectionLabel>
            <p className="mt-1 truncate">{detail.resolvedAt ?? "—"}</p>
          </div>
        </div>
      </div>

      <SheetFooter>
        {isPipelineStatus(detail.status) ? (
          <p className="text-xs text-muted-foreground">
            Pipeline-verified status — no manual changes available.
          </p>
        ) : detail.status === "OPEN" ? (
          <div className="flex gap-2">
            <Button onClick={() => updateStatus.mutate("DONE")} disabled={updateStatus.isPending}>
              Mark done
            </Button>
            <Button
              variant="outline"
              onClick={() => updateStatus.mutate("DISMISSED")}
              disabled={updateStatus.isPending}
            >
              Dismiss
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            onClick={() => updateStatus.mutate("OPEN")}
            disabled={updateStatus.isPending}
          >
            Reopen
          </Button>
        )}
      </SheetFooter>
    </>
  );
}

/** Mirrors `dashboard-view.tsx`'s `PriorityBadge` color mapping exactly. */
function PriorityBadge({ priority }: { priority: RecPriority }) {
  const variant = priority === "CRITICAL" ? "destructive" : priority === "HIGH" ? "secondary" : "outline";
  return (
    <Badge variant={variant} className="shrink-0">
      {priority}
    </Badge>
  );
}

function SourceBadge({ source }: { source: RecSource }) {
  return (
    <Badge variant="outline" className="shrink-0">
      {source}
    </Badge>
  );
}

/**
 * OPEN/DONE/DISMISSED are plain, user-owned states. VALIDATED/REGRESSED are pipeline-owned
 * (docs/Frontend-Design.md §9) and always render as a visually distinct, non-interactive
 * badge — this component only ever emits a `<span>`, never a button or dropdown item.
 */
function StatusBadge({ status }: { status: RecStatus }) {
  if (status === "VALIDATED") {
    return (
      <Badge
        variant="outline"
        className="shrink-0 border-duo-green/40 text-duo-green"
      >
        VALIDATED
      </Badge>
    );
  }
  if (status === "REGRESSED") {
    return (
      <Badge variant="destructive" className="shrink-0">
        REGRESSED
      </Badge>
    );
  }
  const variant = status === "DONE" ? "secondary" : status === "DISMISSED" ? "outline" : "default";
  return (
    <Badge variant={variant} className="shrink-0">
      {status}
    </Badge>
  );
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs font-semibold text-muted-foreground">
        {label}
      </span>
      <div className="flex gap-0.5" role="img" aria-label={`${label} ${value} of 5`}>
        {[1, 2, 3, 4, 5].map((segment) => (
          <span
            key={segment}
            className={
              segment <= value ? "h-1.5 w-3 rounded-full bg-primary" : "h-1.5 w-3 rounded-full bg-secondary"
            }
          />
        ))}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="section-label">{children}</span>
  );
}

function formatEvidenceValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.problem.detail ?? error.problem.title;
  return "Something went wrong. Please try again.";
}
