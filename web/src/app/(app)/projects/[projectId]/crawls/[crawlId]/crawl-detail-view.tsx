"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Crawl, CrawlStatus } from "@contracts/api/crawls";
import type { PageSnapshotDetail, PageSnapshotSummary } from "@contracts/api/snapshots";
import type { Page } from "@contracts/api/common";
import { apiFetch, ApiError, API_BASE_URL } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

const IN_FLIGHT: CrawlStatus[] = ["QUEUED", "CRAWLING", "ANALYZING"];

const STATUS_VARIANT: Record<CrawlStatus, "default" | "secondary" | "destructive"> = {
  QUEUED: "secondary",
  CRAWLING: "secondary",
  ANALYZING: "secondary",
  COMPLETED: "default",
  COMPLETED_DEGRADED: "secondary",
  FAILED: "destructive",
  CANCELED: "destructive",
};

interface LiveProgress {
  readonly pagesFound: number;
  readonly pagesCrawled: number;
  readonly currentUrl: string | null;
  readonly etaSeconds: number | null;
}

export function CrawlDetailView({
  projectId,
  crawlId,
  initialCrawl,
  initialPages,
}: {
  projectId: string;
  crawlId: string;
  initialCrawl: Crawl;
  initialPages: Page<PageSnapshotSummary>;
}) {
  const queryClient = useQueryClient();
  const [changedOnly, setChangedOnly] = useState(false);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const [liveStage, setLiveStage] = useState<string | null>(null);
  const [liveProgress, setLiveProgress] = useState<LiveProgress | null>(null);

  const { data: crawl } = useQuery({
    queryKey: ["crawl", projectId, crawlId],
    queryFn: () => apiFetch<Crawl>(`/v1/projects/${projectId}/crawls/${crawlId}`),
    initialData: initialCrawl,
  });

  const inFlight = IN_FLIGHT.includes(crawl.status);

  const pagesQuery = useInfiniteQuery({
    queryKey: ["crawl-pages", projectId, crawlId, changedOnly],
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams();
      if (pageParam) search.set("cursor", pageParam);
      if (changedOnly) search.set("changed", "true");
      const qs = search.toString();
      return apiFetch<Page<PageSnapshotSummary>>(
        `/v1/projects/${projectId}/crawls/${crawlId}/pages${qs ? `?${qs}` : ""}`,
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    initialData: changedOnly ? undefined : { pages: [initialPages], pageParams: [null] },
  });

  const pages = pagesQuery.data ? pagesQuery.data.pages.flatMap((page) => page.data) : [];

  const cancelCrawl = useMutation({
    mutationFn: () =>
      apiFetch<Crawl>(`/v1/projects/${projectId}/crawls/${crawlId}/cancel`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["crawl", projectId, crawlId] }),
    onError: (error) => toast.error(errorMessage(error)),
  });

  // Live SSE progress while the crawl is in-flight. The DB row (`crawl`, above) is the
  // source of truth once the crawl finishes — on `done`/`error` we close the stream and
  // let a refetch replace whatever the live frames showed.
  useEffect(() => {
    if (!inFlight) return;

    const source = new EventSource(
      `${API_BASE_URL}/v1/projects/${projectId}/crawls/${crawlId}/progress`,
      { withCredentials: true },
    );

    const handleStage = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data as string) as { message: string };
        setLiveStage(payload.message);
      } catch {
        // Malformed frame — ignore, next tick will correct itself.
      }
    };

    const handleProgress = (event: MessageEvent) => {
      try {
        setLiveProgress(JSON.parse(event.data as string) as LiveProgress);
      } catch {
        // Malformed frame — ignore, next tick will correct itself.
      }
    };

    const finish = () => {
      source.close();
      void queryClient.invalidateQueries({ queryKey: ["crawl", projectId, crawlId] });
      void queryClient.invalidateQueries({ queryKey: ["crawl-pages", projectId, crawlId] });
    };

    const handleError = (event: Event) => {
      const data = (event as MessageEvent).data as string | undefined;
      if (typeof data === "string") {
        try {
          const problem = JSON.parse(data) as { detail?: string; title?: string };
          toast.error(problem.detail ?? problem.title ?? "Crawl progress stream failed.");
        } catch {
          // Not a Problem frame — likely the browser's own connection-error event.
        }
      }
      finish();
    };

    source.addEventListener("stage", handleStage);
    source.addEventListener("progress", handleProgress);
    source.addEventListener("done", finish);
    source.addEventListener("error", handleError);

    return () => {
      source.removeEventListener("stage", handleStage);
      source.removeEventListener("progress", handleProgress);
      source.removeEventListener("done", finish);
      source.removeEventListener("error", handleError);
      source.close();
    };
  }, [inFlight, projectId, crawlId, queryClient]);

  const progressPercent =
    liveProgress && liveProgress.pagesFound > 0
      ? Math.min(100, Math.round((liveProgress.pagesCrawled / liveProgress.pagesFound) * 100))
      : null;

  return (
    <div className="flex flex-col gap-6 p-10">
      <div className="flex items-center justify-between">
        <div>
          <Link
            href={`/projects/${projectId}/crawls`}
            className="text-xs font-semibold text-muted-foreground hover:text-foreground hover:underline"
          >
            ← All crawls
          </Link>
          <div className="mt-1 flex items-center gap-2.5">
            <h1 className="text-2xl font-extrabold tracking-tight">Crawl detail</h1>
            <Badge variant={STATUS_VARIANT[crawl.status]}>{crawl.status}</Badge>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {crawl.trigger === "MANUAL" ? "Manual" : "Scheduled"} · queued{" "}
            {relativeTime(crawl.queuedAt)}
            {crawl.finishedAt && ` · finished ${relativeTime(crawl.finishedAt)}`}
          </p>
        </div>
        {inFlight && (
          <Button
            variant="outline"
            onClick={() => cancelCrawl.mutate()}
            disabled={cancelCrawl.isPending}
          >
            {cancelCrawl.isPending ? "Cancelling…" : "Cancel crawl"}
          </Button>
        )}
      </div>

      {crawl.errorReason && (
        <Alert variant="destructive">
          <AlertDescription>{crawl.errorReason}</AlertDescription>
        </Alert>
      )}

      {inFlight && (
        <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
          <SectionLabel>Live progress</SectionLabel>
          <p className="mt-2 text-sm font-semibold">{liveStage ?? "Connecting…"}</p>
          <Progress value={progressPercent} className="mt-3" />
          <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {liveProgress
                ? `${liveProgress.pagesCrawled} / ${liveProgress.pagesFound} pages`
                : "Waiting for crawler…"}
            </span>
            {liveProgress?.etaSeconds != null && (
              <span>~{formatEta(liveProgress.etaSeconds)} remaining</span>
            )}
          </div>
          {liveProgress?.currentUrl && (
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {liveProgress.currentUrl}
            </p>
          )}
        </div>
      )}

      <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
        <SectionLabel>Stats</SectionLabel>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Discovered" value={crawl.stats.pagesDiscovered} />
          <StatTile label="Crawled" value={crawl.stats.pagesCrawled} />
          <StatTile label="Changed" value={crawl.stats.pagesChanged} />
          <StatTile label="Failed" value={crawl.stats.pagesFailed} />
        </div>
        {crawl.degradation && (
          <div className="mt-3 rounded-lg bg-[oklch(0.9_0.06_80)] px-3 py-2 text-xs text-[oklch(0.4_0.1_70)]">
            Some components degraded during this crawl — results may be partial.
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <SectionLabel>Pages</SectionLabel>
          <Button
            variant={changedOnly ? "secondary" : "outline"}
            size="sm"
            onClick={() => setChangedOnly((value) => !value)}
          >
            {changedOnly ? "Showing changed only" : "Changed only"}
          </Button>
        </div>

        <div className="mt-3 overflow-hidden rounded-xl border border-border">
          {pagesQuery.isLoading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Loading pages…</div>
          ) : pages.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              {changedOnly ? "No changed pages in this crawl." : "No pages captured yet."}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Page</TableHead>
                  <TableHead>HTTP</TableHead>
                  <TableHead>Words</TableHead>
                  <TableHead>Quality</TableHead>
                  <TableHead>Changed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pages.map((page) => (
                  <TableRow
                    key={page.id}
                    className="cursor-pointer"
                    onClick={() => setSelectedSnapshotId(page.id)}
                  >
                    <TableCell>
                      <div className="font-semibold">{page.title ?? "(untitled)"}</div>
                      <div className="max-w-xs truncate text-xs text-muted-foreground">
                        {page.url}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">{page.httpStatus ?? "—"}</TableCell>
                    <TableCell className="text-sm">{page.wordCount ?? "—"}</TableCell>
                    <TableCell className="text-sm">
                      {/* Null is not zero: a page outside the sampled set has no quality
                          score at all, which reads very differently from a score of 0. */}
                      {page.qualityScore === null ? (
                        <span className="text-xs text-muted-foreground">not in sampled set</span>
                      ) : (
                        page.qualityScore
                      )}
                    </TableCell>
                    <TableCell>
                      {page.changed ? (
                        <Badge variant="secondary">Changed</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        {pagesQuery.hasNextPage && (
          <Button
            variant="outline"
            onClick={() => pagesQuery.fetchNextPage()}
            disabled={pagesQuery.isFetchingNextPage}
            className="mt-4"
          >
            {pagesQuery.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        )}
      </div>

      <Sheet
        open={selectedSnapshotId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedSnapshotId(null);
        }}
      >
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
          {selectedSnapshotId && (
            <SnapshotDetailPanel projectId={projectId} snapshotId={selectedSnapshotId} />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function SnapshotDetailPanel({
  projectId,
  snapshotId,
}: {
  projectId: string;
  snapshotId: string;
}) {
  const { data: snapshot, isLoading } = useQuery({
    queryKey: ["snapshot", projectId, snapshotId],
    queryFn: () =>
      apiFetch<PageSnapshotDetail>(`/v1/projects/${projectId}/snapshots/${snapshotId}`),
  });

  return (
    <>
      <SheetHeader>
        <SheetTitle>{snapshot ? (snapshot.title ?? snapshot.url) : "Loading…"}</SheetTitle>
        {snapshot && <SheetDescription>{snapshot.url}</SheetDescription>}
      </SheetHeader>
      <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-4">
        {isLoading || !snapshot ? (
          <p className="text-sm text-muted-foreground">Loading snapshot…</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <DetailStat label="Structured data" value={snapshot.hasStructuredData ? "Present" : "Absent"} />
              <DetailStat label="HTTP status" value={snapshot.httpStatus ?? "—"} />
              <DetailStat label="Internal links" value={snapshot.internalLinkCount ?? "—"} />
              <DetailStat label="External links" value={snapshot.externalLinkCount ?? "—"} />
            </div>

            {snapshot.carriedForwardFromId && (
              <p className="rounded-lg bg-secondary/50 px-3 py-2 text-xs text-muted-foreground">
                Analysis carried forward from an earlier crawl.
              </p>
            )}

            <div>
              <SectionLabel>Extracted</SectionLabel>
              <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-secondary p-3 text-xs whitespace-pre-wrap">
                {JSON.stringify(snapshot.extracted, null, 2)}
              </pre>
            </div>

            <div>
              <SectionLabel>Quality</SectionLabel>
              {snapshot.quality === null ? (
                <NotYetMeasured caption="not analyzed" />
              ) : (
                <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-secondary p-3 text-xs whitespace-pre-wrap">
                  {JSON.stringify(snapshot.quality, null, 2)}
                </pre>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-secondary p-3">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="text-xl font-extrabold">{value}</span>
    </div>
  );
}

function DetailStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
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
    <div className="mt-2 flex items-center gap-3 rounded-xl border-2 border-dashed border-border bg-secondary/50 px-4 py-3">
      <span className="text-lg font-extrabold text-muted-foreground/50">—</span>
      <span className="text-xs text-muted-foreground">{caption}</span>
    </div>
  );
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

function relativeTime(iso: string): string {
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
