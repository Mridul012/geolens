"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Crawl, CrawlStatus } from "@contracts/api/crawls";
import type { Page } from "@contracts/api/common";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const STATUS_VARIANT: Record<CrawlStatus, "default" | "secondary" | "destructive"> = {
  QUEUED: "secondary",
  CRAWLING: "secondary",
  ANALYZING: "secondary",
  COMPLETED: "default",
  COMPLETED_DEGRADED: "secondary",
  FAILED: "destructive",
  CANCELED: "destructive",
};

export function CrawlsView({
  projectId,
  initialCrawls,
}: {
  projectId: string;
  initialCrawls: Page<Crawl>;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ["crawls", projectId],
    queryFn: ({ pageParam }) =>
      apiFetch<Page<Crawl>>(
        `/v1/projects/${projectId}/crawls${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ""}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    initialData: { pages: [initialCrawls], pageParams: [null] },
  });

  const crawls = data.pages.flatMap((page) => page.data);

  const startCrawl = useMutation({
    mutationFn: () =>
      apiFetch<Crawl>(`/v1/projects/${projectId}/crawls`, {
        method: "POST",
        // The API's body schema defaults an omitted body to {} but rejects a literal
        // `null` — an empty POST with no explicit body parses server-side as `null`.
        body: {},
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: async (crawl) => {
      await queryClient.invalidateQueries({ queryKey: ["crawls", projectId] });
      router.push(`/projects/${projectId}/crawls/${crawl.id}`);
    },
    onError: (error) => {
      // 409 CRAWL_ALREADY_ACTIVE and friends surface as a toast rather than an inline
      // crash — starting a crawl is a lightweight action, not a form submission.
      toast.error(errorMessage(error));
    },
  });

  return (
    <div className="flex flex-col gap-6 p-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Crawls</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Every crawl run for this project, with status and page counts.
          </p>
        </div>
        <Button onClick={() => startCrawl.mutate()} disabled={startCrawl.isPending}>
          {startCrawl.isPending ? "Starting…" : "Start crawl →"}
        </Button>
      </div>

      <div className="rounded-2xl border border-border bg-card shadow-sm">
        {crawls.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            No crawls yet. Start one to begin measuring AI visibility.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Pages crawled</TableHead>
                <TableHead>Finished</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {crawls.map((crawl) => (
                <TableRow
                  key={crawl.id}
                  className="cursor-pointer"
                  onClick={() => router.push(`/projects/${projectId}/crawls/${crawl.id}`)}
                >
                  <TableCell>
                    <Link
                      href={`/projects/${projectId}/crawls/${crawl.id}`}
                      className="inline-flex items-center gap-2 font-semibold hover:underline"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <Badge variant={STATUS_VARIANT[crawl.status]}>{crawl.status}</Badge>
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {crawl.trigger === "MANUAL" ? "Manual" : "Scheduled"}
                  </TableCell>
                  <TableCell className="text-sm">
                    {crawl.stats.pagesCrawled} / {crawl.stats.pagesDiscovered}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {/* Null is not zero: a crawl that hasn't finished shows a dash, not an
                        epoch date or a blank cell. */}
                    {crawl.finishedAt ? relativeTime(crawl.finishedAt) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {hasNextPage && (
        <Button
          variant="outline"
          onClick={() => fetchNextPage()}
          disabled={isFetchingNextPage}
          className="self-center"
        >
          {isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}
    </div>
  );
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
