"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { EventPayload } from "@contracts/api/snapshots";
import { apiFetch } from "@/lib/api/client";
import { HISTORY_PAGE_SIZE, type EventPage } from "@/lib/api/events";
import { markHistorySeen } from "@/lib/history-seen";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type Tone = "good" | "bad" | "neutral";

interface Described {
  readonly title: string;
  readonly detail: string | null;
  readonly href: string | null;
  readonly tone: Tone;
}

export function HistoryView({
  projectId,
  initialPage,
}: {
  projectId: string;
  initialPage: EventPage;
}) {
  // Opening History is what "seeing" new crawl results means for the sidebar dot.
  useEffect(() => markHistorySeen(projectId), [projectId]);

  const feed = useInfiniteQuery({
    queryKey: ["events", projectId, "feed"],
    queryFn: ({ pageParam }) =>
      apiFetch<EventPage>(
        `/v1/projects/${projectId}/events?limit=${HISTORY_PAGE_SIZE}` +
          (pageParam === null ? "" : `&cursor=${encodeURIComponent(pageParam)}`),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    initialData: { pages: [initialPage], pageParams: [null] },
  });

  const events = feed.data.pages.flatMap((page) => page.data);

  return (
    <div className="flex flex-col gap-6 p-5 md:p-10">
      <div>
        <h1 className="text-[28px] leading-tight font-extrabold tracking-[-0.02em]">History</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          What changed, newest first: crawls, scores, citations and AI crawler access.
        </p>
      </div>

      <div className="panel p-6">
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing has happened yet. Run your first crawl and its results will show up here.
          </p>
        ) : (
          <ol className="flex flex-col">
            {events.map((event) => (
              <EventRow key={event.id} event={event} projectId={projectId} />
            ))}
          </ol>
        )}

        {feed.isFetchNextPageError && (
          <p className="mt-4 text-sm text-destructive">Couldn&apos;t load older events.</p>
        )}
        {feed.hasNextPage && (
          <Button
            variant="outline"
            className="mt-5"
            disabled={feed.isFetchingNextPage}
            onClick={() => void feed.fetchNextPage()}
          >
            {feed.isFetchingNextPage ? "Loading…" : "Load older events"}
          </Button>
        )}
      </div>
    </div>
  );
}

function EventRow({ event, projectId }: { event: EventPayload; projectId: string }) {
  const described = describeEvent(event, projectId);
  const body = (
    <>
      <span
        className={cn(
          "mt-1.5 h-2 w-2 shrink-0 rounded-full",
          described.tone === "good" && "bg-emerald-500",
          described.tone === "bad" && "bg-destructive",
          described.tone === "neutral" && "bg-muted-foreground/50",
        )}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-semibold">{described.title}</span>
        {described.detail && (
          <span className="text-sm text-muted-foreground">{described.detail}</span>
        )}
      </span>
      {/* The server renders in its own timezone, the browser in the viewer's. */}
      <time
        dateTime={event.createdAt}
        className="shrink-0 text-xs text-muted-foreground"
        suppressHydrationWarning
      >
        {formatDate(event.createdAt)}
      </time>
    </>
  );

  return (
    <li className="border-b border-border last:border-b-0">
      {described.href ? (
        <Link
          href={described.href}
          className="-mx-3 flex items-start gap-3 rounded-xl px-3 py-3.5 hover:bg-secondary"
        >
          {body}
        </Link>
      ) : (
        <div className="flex items-start gap-3 py-3.5">{body}</div>
      )}
    </li>
  );
}

/** Plain-language copy for each kind the backend records; unknown kinds still show up. */
export function describeEvent(event: EventPayload, projectId: string): Described {
  const p = event.payload;
  const base = `/projects/${projectId}`;
  const crawlHref = event.crawlId ? `${base}/crawls/${event.crawlId}` : null;

  switch (event.kind) {
    case "crawl_completed": {
      const degraded = str(p.status) === "COMPLETED_DEGRADED";
      return {
        title: degraded ? "Crawl finished with gaps" : "Crawl finished",
        detail: joinParts([
          countOf(p.pagesCrawled, "page crawled", "pages crawled"),
          countOf(p.pagesChanged, "changed", "changed"),
          countOf(p.pagesFailed, "failed", "failed"),
        ]),
        href: crawlHref,
        tone: degraded ? "neutral" : "good",
      };
    }
    case "crawl_failed":
      return {
        title: "Crawl failed",
        detail:
          str(p.reason) === "no_pages_readable"
            ? "None of your pages could be read."
            : humanize(str(p.reason)),
        href: crawlHref,
        tone: "bad",
      };
    case "score_changed": {
      const composite = num(p.composite);
      const fromRun = str(p.promptRunId) !== null;
      return {
        title:
          composite === null
            ? "Score not published — not enough evidence yet"
            : `Score updated to ${Math.round(composite)}`,
        detail: fromRun ? "After a prompt run" : "After a crawl",
        href: fromRun ? `${base}/prompts` : (crawlHref ?? base),
        tone: "neutral",
      };
    }
    case "ai_crawler_blocked": {
      const bots = list(p.bots)
        .map((entry) => (isRecord(entry) ? str(entry.bot) : null))
        .filter((bot): bot is string => bot !== null);
      return {
        title: `${botList(bots)} ${bots.length === 1 ? "is" : "are"} blocked from your site`,
        detail: "AI engines can't read pages they're blocked from. The fix is on Crawler Access.",
        href: `${base}/crawler-access`,
        tone: "bad",
      };
    }
    case "ai_crawler_unblocked": {
      const bots = list(p.bots).filter((bot): bot is string => typeof bot === "string");
      return {
        title: `${botList(bots)} can read your site again`,
        detail: null,
        href: `${base}/crawler-access`,
        tone: "good",
      };
    }
    case "citation_gained":
    case "citation_lost": {
      const from = num(p.from);
      const to = num(p.to);
      const gained = event.kind === "citation_gained";
      return {
        title: gained ? "Cited more by AI engines" : "Cited less by AI engines",
        detail:
          to === null
            ? null
            : from === null
              ? `Citation score first measured at ${Math.round(to)}`
              : `Citation score ${gained ? "rose" : "fell"} from ${Math.round(from)} to ${Math.round(to)}`,
        href: `${base}/prompts`,
        tone: gained ? "good" : "bad",
      };
    }
    case "prompt_run_completed":
    case "prompt_run_failed": {
      const failed = event.kind === "prompt_run_failed";
      const mention = num(p.mentionRate);
      const citation = num(p.citationShare);
      return {
        title: failed ? "Prompt run failed" : "Prompt run finished",
        detail: failed
          ? null
          : joinParts([
              mention === null ? null : `Mentioned in ${Math.round(mention)}% of answers`,
              citation === null ? null : `cited in ${Math.round(citation)}%`,
            ]),
        href: `${base}/prompts`,
        tone: failed ? "bad" : "neutral",
      };
    }
    default:
      return { title: humanize(event.kind) ?? event.kind, detail: null, href: crawlHref, tone: "neutral" };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function humanize(value: string | null): string | null {
  if (value === null) return null;
  const spaced = value.replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function countOf(value: unknown, singular: string, plural: string): string | null {
  const count = num(value);
  return count === null ? null : `${count} ${count === 1 ? singular : plural}`;
}

function joinParts(parts: Array<string | null>): string | null {
  const present = parts.filter((part): part is string => part !== null);
  return present.length === 0 ? null : present.join(", ");
}

function botList(bots: string[]): string {
  if (bots.length === 0) return "AI crawlers";
  if (bots.length <= 3) return bots.join(", ");
  return `${bots.slice(0, 2).join(", ")} and ${bots.length - 2} more`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
