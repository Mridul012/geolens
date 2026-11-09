"use client";

import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Dashboard } from "@contracts/api/dashboard";
import type { Score } from "@contracts/api/scores";
import type { Crawl, CrawlStatus } from "@contracts/api/crawls";
import type { Recommendation } from "@contracts/api/recommendations";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";

const SUB_SCORES: { key: keyof Score & string; label: string }[] = [
  { key: "scoreCitation", label: "Citation" },
  { key: "scoreRetrievability", label: "Retrievability" },
  { key: "scoreContentQuality", label: "Content Quality" },
  { key: "scoreTopicCoverage", label: "Topic Coverage" },
  { key: "scoreTechnical", label: "Technical" },
  { key: "scoreTrust", label: "Trust" },
];

const IN_FLIGHT: CrawlStatus[] = ["QUEUED", "CRAWLING", "ANALYZING"];

export function DashboardView({
  projectId,
  initialDashboard,
}: {
  projectId: string;
  initialDashboard: Dashboard;
}) {
  const queryClient = useQueryClient();

  const { data: dashboard } = useQuery({
    queryKey: ["dashboard", projectId],
    queryFn: () => apiFetch<Dashboard>(`/v1/projects/${projectId}/dashboard`),
    initialData: initialDashboard,
    refetchInterval: (query) => {
      const status = query.state.data?.crawlStatus?.status;
      return status && IN_FLIGHT.includes(status) ? 3000 : false;
    },
  });

  const startCrawl = useMutation({
    mutationFn: () =>
      apiFetch<Crawl>(`/v1/projects/${projectId}/crawls`, {
        method: "POST",
        // The API's body schema defaults an omitted body to {} but rejects a literal
        // `null` — an empty POST with no explicit body parses server-side as `null`.
        body: {},
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["dashboard", projectId] }),
  });

  const inFlight = dashboard.crawlStatus !== null && IN_FLIGHT.includes(dashboard.crawlStatus.status);

  return (
    <div className="flex flex-col gap-6 p-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Dashboard</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {dashboard.hasCompletedCrawl
              ? `Last crawl finished ${relativeTime(dashboard.crawlStatus?.finishedAt ?? null)}`
              : "No crawl yet"}
          </p>
        </div>
        <Button onClick={() => startCrawl.mutate()} disabled={startCrawl.isPending || inFlight}>
          {inFlight
            ? "Crawl in progress…"
            : dashboard.hasCompletedCrawl
              ? "Re-run crawl"
              : "Start crawl →"}
        </Button>
      </div>

      {startCrawl.isError && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(startCrawl.error)}</AlertDescription>
        </Alert>
      )}

      {!dashboard.hasCompletedCrawl && !inFlight && (
        <div className="rounded-2xl border-2 border-dashed border-border bg-secondary/40 p-8 text-center">
          <p className="text-lg font-bold">Nothing measured yet</p>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
            Start your first crawl to see your AI Visibility Score, check whether AI crawlers
            can read your site, and get a fix list.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <ScoreCard dashboard={dashboard} />
        <TrendCard trend={dashboard.scoreTrend} />
        <CrawlStatusCard dashboard={dashboard} />
      </div>

      <SubScoresCard score={dashboard.latestScore} />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="rounded-2xl border border-border bg-card p-6 shadow-sm lg:col-span-2">
          <SectionLabel>Top recommendations</SectionLabel>
          {dashboard.topRecommendations.length === 0 ? (
            <EmptyRow text="No recommendations yet." />
          ) : (
            <div className="mt-3 flex flex-col">
              {/* dashboardSchema types this loosely (Record<string, unknown>[]) since it's
                  stored as a JSON blob at aggregate time, but it's always Recommendation[]. */}
              {(dashboard.topRecommendations as unknown as Recommendation[]).map((rec) => (
                <div
                  key={rec.id}
                  className="flex items-center gap-3.5 border-b border-border py-3.5 last:border-none"
                >
                  <PriorityBadge priority={rec.priority} />
                  <span className="flex-1 text-sm font-semibold">{rec.title}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
          <SectionLabel>Missing topics</SectionLabel>
          {dashboard.topMissingTopics.length === 0 ? (
            <EmptyRow text="No gaps found yet." />
          ) : (
            <div className="mt-3 flex flex-col">
              {dashboard.topMissingTopics.map((topic) => (
                <div
                  key={topic.topicId}
                  className="flex items-center justify-between border-b border-border py-3 text-sm last:border-none"
                >
                  <span className="font-semibold">{topic.label}</span>
                  <span className="text-xs font-bold text-destructive">
                    {topic.missing ? "absent" : `gap ${topic.gap ?? "—"}`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
          <SectionLabel>Prompt tracking</SectionLabel>
          {dashboard.promptSummary === null ? (
            <NotYetMeasured caption="no prompt runs yet" />
          ) : (
            <div className="mt-3 flex gap-7">
              <Stat value={formatPercent(dashboard.promptSummary.mentionRate)} label="mention rate" />
              <Stat value={formatPercent(dashboard.promptSummary.citationShare)} label="citation share" />
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
          <SectionLabel>Comparison</SectionLabel>
          {dashboard.comparisonSummary === null ? (
            <NotYetMeasured caption="add a competitor to compare" />
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              Comparison data is available — see the full comparison page (coming soon).
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function ScoreCard({ dashboard }: { dashboard: Dashboard }) {
  const composite = dashboard.latestScore?.composite ?? null;
  const circumference = 2 * Math.PI * 54;
  const dash = composite === null ? 0 : (composite / 100) * circumference;

  return (
    <div className="flex items-center gap-6 rounded-2xl border border-border bg-card p-6 shadow-sm">
      <div className="relative h-32 w-32 shrink-0">
        <svg viewBox="0 0 128 128" className="h-32 w-32 -rotate-90">
          <circle cx="64" cy="64" r="54" fill="none" stroke="var(--secondary)" strokeWidth={12} />
          {composite !== null && (
            <circle
              cx="64"
              cy="64"
              r="54"
              fill="none"
              stroke="var(--primary)"
              strokeWidth={12}
              strokeLinecap="round"
              strokeDasharray={`${dash} ${circumference}`}
            />
          )}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-4xl font-extrabold tracking-tight">{composite ?? "—"}</span>
          <span className="text-[10px] text-muted-foreground">/ 100</span>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-bold tracking-wide text-muted-foreground uppercase">
          AI Visibility Score
        </span>
        {composite === null && (
          <span className="text-xs text-muted-foreground">Not yet measured</span>
        )}
      </div>
    </div>
  );
}

function TrendCard({ trend }: { trend: Dashboard["scoreTrend"] }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
      <SectionLabel>Score trend</SectionLabel>
      {trend.length < 2 ? (
        <NotYetMeasured caption="not enough history yet" />
      ) : (
        <Sparkline points={trend.map((point) => point.composite)} />
      )}
    </div>
  );
}

function Sparkline({ points }: { points: number[] }) {
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const coords = points.map((value, index) => {
    const x = (index / (points.length - 1)) * 260;
    const y = 62 - ((value - min) / range) * 56;
    return `${x},${y}`;
  });

  return (
    <svg viewBox="0 0 260 70" className="mt-3 h-16 w-full" preserveAspectRatio="none">
      <polyline
        points={coords.join(" ")}
        fill="none"
        stroke="var(--primary)"
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CrawlStatusCard({ dashboard }: { dashboard: Dashboard }) {
  const crawl = dashboard.crawlStatus;
  return (
    <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <SectionLabel>Crawl status</SectionLabel>
        {crawl && <CrawlStatusBadge status={crawl.status} />}
      </div>
      <div className="mt-3 text-2xl font-extrabold">
        {dashboard.indexedPages} <span className="text-sm font-medium text-muted-foreground">pages indexed</span>
      </div>
      {crawl?.degradation && (
        <div className="mt-3 rounded-lg bg-[oklch(0.9_0.06_80)] px-3 py-2 text-xs text-[oklch(0.4_0.1_70)]">
          Some components degraded during this crawl — results may be partial.
        </div>
      )}
    </div>
  );
}

function SubScoresCard({ score }: { score: Dashboard["latestScore"] }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
      <SectionLabel>Score breakdown</SectionLabel>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {SUB_SCORES.map(({ key, label }) => {
          const value = score?.[key] ?? null;
          return (
            <div
              key={key}
              className={
                value === null
                  ? "flex flex-col gap-1 rounded-xl border-2 border-dashed border-border p-3"
                  : "flex flex-col gap-1 rounded-xl bg-secondary p-3"
              }
            >
              <span className="text-[11px] text-muted-foreground">{label}</span>
              <span className={value === null ? "text-xl font-extrabold text-muted-foreground/50" : "text-xl font-extrabold"}>
                {value ?? "—"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CrawlStatusBadge({ status }: { status: CrawlStatus }) {
  const variant = status === "FAILED" ? "destructive" : status === "COMPLETED" ? "default" : "secondary";
  return <Badge variant={variant}>{status}</Badge>;
}

function PriorityBadge({ priority }: { priority: string }) {
  const variant = priority === "CRITICAL" ? "destructive" : priority === "HIGH" ? "secondary" : "outline";
  return (
    <Badge variant={variant} className="shrink-0">
      {priority}
    </Badge>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-xs font-bold tracking-wide text-muted-foreground uppercase">
      {children}
    </span>
  );
}

function NotYetMeasured({ caption }: { caption: string }) {
  return (
    <div className="mt-3 flex items-center gap-3 rounded-xl border-2 border-dashed border-border bg-secondary/50 px-4 py-3">
      <span className="text-lg font-extrabold text-muted-foreground/50">—</span>
      <span className="text-xs text-muted-foreground">{caption}</span>
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <p className="mt-3 text-sm text-muted-foreground">{text}</p>;
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div className="text-xl font-extrabold">{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}%`;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const hours = Math.round(diffMs / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.problem.detail ?? error.problem.title;
  return "Something went wrong. Please try again.";
}
