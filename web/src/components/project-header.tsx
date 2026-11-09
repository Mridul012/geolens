"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import type { ProjectDetail } from "@contracts/api/projects";
import type { Me } from "@contracts/api/auth";
import { apiFetch } from "@/lib/api/client";
import type { EventPage } from "@/lib/api/events";
import { focusBlur } from "@/lib/focus";
import { readHistorySeen, subscribeHistorySeen } from "@/lib/history-seen";
import { cn } from "@/lib/utils";
import { SignOutButton } from "@/components/sign-out-button";
import { Wordmark } from "@/components/brand-mark";

/** `segment: ""` is the dashboard itself. Order follows the PRD's journey, not alphabet. */
const NAV_ITEMS: ReadonlyArray<{ label: string; segment: string }> = [
  { label: "Dashboard", segment: "" },
  { label: "Crawls", segment: "crawls" },
  { label: "Crawler access", segment: "crawler-access" },
  { label: "Topics", segment: "topics" },
  { label: "Prompts", segment: "prompts" },
  { label: "Comparison", segment: "comparison" },
  { label: "Recommendations", segment: "recommendations" },
  { label: "History", segment: "history" },
  { label: "Reports", segment: "reports" },
  { label: "Settings", segment: "settings" },
  { label: "Billing", segment: "billing" },
];

/** The kinds that mean "a crawl finished" — the in-app notification of FR-14.1. */
const CRAWL_RESULT_KINDS = ["crawl_completed", "crawl_failed"] as const;

const STRIP_FONT_PX = 28;

/**
 * The project's top bar and tab row, plus the focus strip: the site's own name rendered as
 * out of focus as AI engines find it, kept in view on every page except the dashboard,
 * where the full-size hero takes its place (docs/Frontend-Design.md §3).
 */
export function ProjectHeader({ project, me }: { project: ProjectDetail; me: Me }) {
  const pathname = usePathname();
  const base = `/projects/${project.id}`;
  const hasNewResults = useHasNewCrawlResults(project.id, pathname);
  const onDashboard = pathname === base;
  const ownDomain = project.sites.find((site) => site.role === "OWN")?.domain ?? null;
  const score = project.latestScore?.composite ?? null;

  return (
    <>
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-[1200px] items-center gap-3 px-5 pt-3 md:gap-4 md:px-10">
          <Link href="/projects" aria-label="GEOlens, all projects" className="shrink-0">
            <Wordmark />
          </Link>
          <span aria-hidden="true" className="hidden h-6 w-px bg-border sm:block" />
          <Link
            href="/projects"
            className="flex min-w-0 items-center gap-2 rounded-full px-2.5 py-1.5 text-sm font-bold hover:bg-wall"
          >
            <span className="h-2 w-2 shrink-0 rounded-full bg-foreground" />
            <span className="truncate">{project.name}</span>
            <ChevronIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </Link>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <span
              title={me.email}
              className="hidden h-8 w-8 items-center justify-center rounded-full bg-foreground text-xs font-bold text-background sm:flex"
            >
              {(me.name ?? me.email).slice(0, 1).toUpperCase()}
            </span>
            <span className="hidden text-sm font-semibold lg:inline">{me.name ?? me.email}</span>
            <span className="hidden rounded-full border border-border px-2 py-0.5 text-xs font-semibold text-muted-foreground sm:inline">
              {me.plan === "PRO" ? "Pro plan" : "Free plan"}
            </span>
            <SignOutButton />
          </div>
        </div>

        <nav
          aria-label="Project"
          className="mx-auto flex max-w-[1200px] gap-1 overflow-x-auto px-3 md:px-8"
        >
          {NAV_ITEMS.map(({ label, segment }) => {
            const href = segment === "" ? base : `${base}/${segment}`;
            const isActive =
              segment === "" ? pathname === base : pathname === href || pathname?.startsWith(`${href}/`);
            return (
              <Link
                key={label}
                href={href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex shrink-0 items-center gap-2 border-b-[3px] px-2 pt-3 pb-2.5 text-sm font-semibold whitespace-nowrap transition-colors",
                  isActive
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
                {segment === "history" && hasNewResults && (
                  <span
                    className="h-2 w-2 rounded-full bg-link"
                    aria-label="New crawl results"
                    role="status"
                  />
                )}
              </Link>
            );
          })}
        </nav>
      </header>

      {!onDashboard && (
        <Link
          href={base}
          className="group block border-b border-border bg-wall"
          aria-label={
            score === null
              ? `${ownDomain ?? "Your site"}: AI visibility not yet measured. Open the dashboard.`
              : `${ownDomain ?? "Your site"}: AI visibility ${score} out of 100. Open the dashboard.`
          }
        >
          <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-6 px-5 py-3.5 md:px-10">
            <span
              aria-hidden="true"
              className="min-w-0 truncate text-[28px] leading-none font-extrabold tracking-[-0.03em]"
              style={{ filter: focusBlur(score, STRIP_FONT_PX) }}
            >
              {ownDomain ?? "your site"}
            </span>
            <span aria-hidden="true" className="flex shrink-0 items-baseline gap-2 text-sm text-muted-foreground">
              AI visibility
              {score === null ? (
                <span className="text-foreground">not measured</span>
              ) : (
                <span className="text-[21px] font-extrabold text-foreground tabular-nums group-hover:underline">
                  {score}
                  <span className="text-sm font-semibold text-muted-foreground">/100</span>
                </span>
              )}
            </span>
          </div>
        </Link>
      )}
    </>
  );
}

/**
 * True while a crawl finished after this device last opened History. Visiting History
 * clears it; the server stays the source of truth for the events themselves.
 */
function useHasNewCrawlResults(projectId: string, pathname: string | null): boolean {
  const seenAt = useSyncExternalStore(
    subscribeHistorySeen,
    () => readHistorySeen(projectId),
    () => null,
  );

  const latest = useQuery({
    queryKey: ["events", projectId, "latest-crawl-result"],
    queryFn: async () => {
      const pages = await Promise.all(
        CRAWL_RESULT_KINDS.map((kind) =>
          apiFetch<EventPage>(`/v1/projects/${projectId}/events?kind=${kind}&limit=1`),
        ),
      );
      const times = pages.flatMap((page) =>
        page.data.map((event) => new Date(event.createdAt).getTime()),
      );
      return times.length === 0 ? null : Math.max(...times);
    },
    refetchInterval: 60_000,
  });

  if (pathname === `/projects/${projectId}/history`) return false;
  const latestAt = latest.data ?? null;
  return latestAt !== null && (seenAt === null || latestAt > seenAt);
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth={2}>
      <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
