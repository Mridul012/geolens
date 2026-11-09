"use client";

/**
 * The dashboard as an eye exam (docs/Frontend-Design.md §3): the project reads top to bottom
 * as one chart. Its title is the site's own name, as out of focus as AI engines find it; each
 * acuity line below asks one of the product's questions — can AI reach you, read you, cite
 * you, what to fix — set smaller than the line before, and sharpens as it reaches the middle
 * of the screen. Every number on the old dashboard still appears, on the line it answers.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AccessCheck, Retrievability } from "@contracts/api/analysis";
import type { Dashboard } from "@contracts/api/dashboard";
import type { Crawl, CrawlStatus } from "@contracts/api/crawls";
import type { Recommendation } from "@contracts/api/recommendations";
import { apiFetch, ApiError } from "@/lib/api/client";
import type { SampleAnswer } from "@/lib/evidence";
import { focusBlur } from "@/lib/focus";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";

const IN_FLIGHT: CrawlStatus[] = ["QUEUED", "CRAWLING", "ANALYZING"];

export interface ExamEvidence {
  /** The latest completed crawl's access check; null before one exists or if it failed. */
  readonly access: AccessCheck | null;
  readonly retrievability: Retrievability | null;
  /** One real AI answer from the latest prompt run, as evidence for the "cite" line. */
  readonly sampleAnswer: SampleAnswer | null;
}

const NO_EVIDENCE: ExamEvidence = { access: null, retrievability: null, sampleAnswer: null };

interface ChartLine {
  readonly id: string;
  readonly acuity: string;
  readonly question: string;
  readonly size: string;
  readonly body: ReactNode;
}

export function DashboardView({
  projectId,
  domain = null,
  initialDashboard,
  evidence = NO_EVIDENCE,
}: {
  projectId: string;
  /** The OWN site's domain — the chart's title. */
  domain?: string | null;
  initialDashboard: Dashboard;
  evidence?: ExamEvidence;
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
  const lines = buildLines(projectId, dashboard, evidence);
  const { activeId, register } = useChartReading(lines.map((line) => line.id));

  return (
    <div className="pb-24">
      <section className="px-5 pt-8 pb-12 md:px-10 md:pt-10">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <h1 className="text-[28px] leading-tight font-extrabold tracking-[-0.02em]">Dashboard</h1>
            {dashboard.crawlStatus && <CrawlStatusBadge status={dashboard.crawlStatus.status} />}
          </div>
          <div className="flex items-center gap-4">
            <p className="text-sm text-muted-foreground">
              {dashboard.hasCompletedCrawl
                ? `Last crawl finished ${relativeTime(dashboard.crawlStatus?.finishedAt ?? null)}`
                : "No crawl yet"}
            </p>
            <Button onClick={() => startCrawl.mutate()} disabled={startCrawl.isPending || inFlight}>
              {inFlight ? "Crawl in progress…" : dashboard.hasCompletedCrawl ? "Re-run crawl" : "Start crawl"}
            </Button>
          </div>
        </div>

        {startCrawl.isError && (
          <Alert variant="destructive" className="mt-5">
            <AlertDescription>{errorMessage(startCrawl.error)}</AlertDescription>
          </Alert>
        )}

        <ChartTitle
          domain={domain}
          composite={dashboard.latestScore?.composite ?? null}
          neverCrawled={!dashboard.hasCompletedCrawl && !inFlight}
        />

        {dashboard.crawlStatus?.degradation && (
          <p className="mt-6 max-w-[68ch] border-l-2 border-destructive pl-3 text-sm">
            Some components degraded during this crawl — results may be partial.
          </p>
        )}
      </section>

      <nav
        aria-label="Chart lines"
        className="fixed top-1/2 right-5 z-10 hidden -translate-y-1/2 flex-col gap-1.5 2xl:flex"
      >
        {lines.map((line) => (
          <a
            key={line.id}
            href={`#line-${line.id}`}
            aria-current={activeId === line.id ? "location" : undefined}
            className={cn(
              "rounded-full px-2.5 py-1 text-right text-xs font-semibold tabular-nums transition-colors",
              activeId === line.id
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {line.acuity}
          </a>
        ))}
      </nav>

      {lines.map((line) => (
        <section
          key={line.id}
          id={`line-${line.id}`}
          data-line={line.id}
          ref={register(line.id)}
          className="chart-line grid scroll-mt-28 grid-cols-1 gap-4 border-t border-border px-5 py-14 md:min-h-[62vh] md:grid-cols-[6rem_1fr] md:content-center md:gap-6 md:px-10"
        >
          <span className="text-sm font-semibold text-muted-foreground tabular-nums md:pt-3">{line.acuity}</span>
          <div className="min-w-0">
            <h2 className={cn("chart-question leading-[0.95] font-extrabold tracking-[-0.03em]", line.size)}>
              {line.question}
            </h2>
            <div className="mt-8 max-w-[72ch]">{line.body}</div>
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * Which line is being read, and which lines have come into focus. Each line sharpens once,
 * when it first crosses the middle of the screen; it never blurs again.
 */
function useChartReading(ids: readonly string[]) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  // A stable key for the set of lines, so the observer is rebuilt only when that set changes.
  const idsKey = ids.join("|");

  useEffect(() => {
    const nodes = [...elements.current.values()];
    if (typeof IntersectionObserver === "undefined") {
      nodes.forEach((node) => node.setAttribute("data-inview", ""));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.setAttribute("data-inview", "");
          setActiveId((entry.target as HTMLElement).dataset.line ?? null);
        }
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [idsKey]);

  const register = (id: string) => (node: HTMLElement | null) => {
    if (node) elements.current.set(id, node);
    else elements.current.delete(id);
  };

  return { activeId, register };
}

/** The chart's title: the patient's own name, rendered as out of focus as AI finds it. */
function ChartTitle({
  domain,
  composite,
  neverCrawled,
}: {
  domain: string | null;
  composite: number | null;
  neverCrawled: boolean;
}) {
  const name = domain ?? "your site";
  const size = heroSizeFor(name);
  // Blur is sized to the type tier, so a long (smaller) domain is exactly as out of focus as
  // a short one with the same score.
  const style: CSSProperties = { filter: focusBlur(composite, size.px) };

  return (
    <div className="mt-10 grid grid-cols-1 items-end gap-8 md:grid-cols-[1fr_auto]">
      <div className="min-w-0">
        <p className="text-sm text-muted-foreground">How clearly AI engines see</p>
        <p
          className={`focus-pull mt-2 ${size.className} leading-[0.95] font-extrabold tracking-[-0.035em] [overflow-wrap:anywhere]`}
          style={style}
          aria-hidden="true"
        >
          {withDomainBreaks(name)}
        </p>
        <span className="sr-only">{name}</span>
        {neverCrawled ? (
          <div className="mt-5 max-w-md">
            <p className="text-lg font-bold">Nothing measured yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Start your first crawl to bring this into focus. Then read down the chart: whether AI can reach,
              read and cite you, and what to fix first.
            </p>
          </div>
        ) : (
          <p className="mt-5 max-w-md text-sm text-muted-foreground">
            The sharper your name, the more clearly AI engines can use your site. Read down the chart to see why.
          </p>
        )}
      </div>

      <div className="flex items-end gap-3 md:flex-col md:items-end md:gap-1">
        {composite === null ? (
          <>
            <span
              aria-hidden="true"
              className="out-of-focus text-[89px] leading-[0.85] font-extrabold tracking-[-0.04em]"
            >
              00
            </span>
            <span className="text-sm font-semibold text-muted-foreground">Not yet measured</span>
          </>
        ) : (
          <>
            <span className="text-[89px] leading-[0.85] font-extrabold tracking-[-0.04em] tabular-nums">
              {composite}
            </span>
            <span className="text-sm text-muted-foreground">AI visibility score, out of 100</span>
          </>
        )}
      </div>
    </div>
  );
}

function buildLines(projectId: string, dashboard: Dashboard, evidence: ExamEvidence): ChartLine[] {
  const base = `/projects/${projectId}`;
  const score = dashboard.latestScore;
  const prompt = dashboard.promptSummary;
  const { access, retrievability, sampleAnswer } = evidence;
  const allowed = access?.bots.filter((bot) => bot.allowed).length ?? 0;
  const crawl = dashboard.crawlStatus;
  const crawlDone = crawl !== null && (crawl.status === "COMPLETED" || crawl.status === "COMPLETED_DEGRADED");
  // dashboardSchema types this loosely (a JSON blob built at aggregate time); it is always
  // Recommendation[].
  const recommendations = dashboard.topRecommendations as unknown as Recommendation[];

  return [
    {
      id: "reach",
      acuity: "20/200",
      question: "Can AI reach you?",
      size: "text-[clamp(2.5rem,6.5vw,5.5rem)]",
      body: (
        <>
          {access ? (
            <>
              <Verdict>
                {allowed === access.bots.length
                  ? `Yes. All ${access.bots.length} AI crawlers can read your site.`
                  : allowed === 0
                    ? `No. All ${access.bots.length} AI crawlers are blocked.`
                    : `Partly. ${allowed} of ${access.bots.length} AI crawlers can read your site.`}
              </Verdict>
              <ul className="mt-6 grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
                {access.bots.map((bot) => (
                  <li key={bot.bot} className="flex items-center gap-2 text-sm">
                    <span className={bot.allowed ? "text-duo-green" : "text-destructive"} aria-hidden="true">
                      {bot.allowed ? "●" : "■"}
                    </span>
                    <span className="font-semibold">{bot.bot}</span>
                    <span className="text-muted-foreground">
                      {bot.allowed ? "allowed" : `blocked by ${bot.blockedBy ?? "your site"}`}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-sm text-muted-foreground">
                llms.txt {access.llmsTxt.present ? "is present" : "is missing"}; robots.txt{" "}
                {access.robotsTxtPresent ? "is present" : "is missing"}.{" "}
                <Link href={`${base}/crawler-access`} className="font-semibold text-link underline">
                  {allowed < access.bots.length ? "Get the fix" : "See the details"}
                </Link>
              </p>
            </>
          ) : (
            <NotYet>The AI crawler check runs with your first crawl.</NotYet>
          )}
          <dl className="mt-8 grid grid-cols-2 gap-6 sm:grid-cols-3">
            <Figure label="Technical" value={score?.scoreTechnical ?? null} />
          </dl>
        </>
      ),
    },
    {
      id: "read",
      acuity: "20/100",
      question: "Can it read you?",
      size: "text-[clamp(2.1rem,5vw,4.25rem)]",
      body: (
        <>
          {retrievability && retrievability.questionsJudged > 0 ? (
            <Verdict>
              Your content answers {retrievability.questionsAnswered} of {retrievability.questionsJudged} buyer
              questions fully, and {retrievability.questionsPartial} partly.
            </Verdict>
          ) : (
            <NotYet>Retrievability is measured after a crawl with AI analysis.</NotYet>
          )}
          <dl className="mt-8 grid grid-cols-2 gap-6 sm:grid-cols-3">
            <Figure label="Retrievability" value={score?.scoreRetrievability ?? null} />
            <Figure label="Content quality" value={score?.scoreContentQuality ?? null} />
            <Figure label="Topic coverage" value={score?.scoreTopicCoverage ?? null} />
          </dl>
          {dashboard.topMissingTopics.length > 0 && (
            <div className="mt-8">
              <h3 className="section-label">Topics AI engines can&apos;t find on your site</h3>
              <ul className="mt-3 flex flex-col">
                {dashboard.topMissingTopics.map((topic) => (
                  <li
                    key={topic.topicId}
                    className="flex items-center justify-between gap-3 border-b border-border py-2.5 text-sm last:border-none"
                  >
                    <span className="font-semibold">{topic.label}</span>
                    {topic.missing ? (
                      <span className="shrink-0 text-xs font-bold text-destructive">Absent</span>
                    ) : topic.gap === null ? (
                      // Unmeasured is not bad news: muted, never the destructive red.
                      <span className="shrink-0 text-xs text-muted-foreground">Gap not measured</span>
                    ) : (
                      <span className="shrink-0 text-xs font-bold text-destructive">Gap {topic.gap}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {crawl && crawlDone && (
            <p className="mt-6 text-sm">
              <Link href={`${base}/crawls/${crawl.id}#through-the-lens`} className="font-semibold text-link underline">
                See your pages through the lens
              </Link>
            </p>
          )}
        </>
      ),
    },
    {
      id: "cite",
      acuity: "20/50",
      question: "Does it cite you?",
      size: "text-[clamp(1.85rem,3.8vw,3.25rem)]",
      body: (
        <>
          {prompt ? (
            <Verdict>
              AI engines mention you in {pct(prompt.mentionRate)} of answers and cite you in{" "}
              {pct(prompt.citationShare)}.
            </Verdict>
          ) : (
            <NotYet>No prompt runs yet. Prompt tracking asks AI engines your buyers&apos; questions.</NotYet>
          )}
          <dl className="mt-8 grid grid-cols-2 gap-6 sm:grid-cols-3">
            <Figure label="Citation" value={score?.scoreCitation ?? null} />
          </dl>
          {sampleAnswer && (
            <blockquote className="mt-8 border-l-[3px] border-foreground pl-4">
              <p className="line-clamp-5 leading-relaxed">{sampleAnswer.text}</p>
              <footer className="mt-2 text-sm text-muted-foreground">
                One real answer from {sampleAnswer.engine},{" "}
                {sampleAnswer.brandCited
                  ? "which cites you"
                  : sampleAnswer.brandMentioned
                    ? "which mentions you without a citation"
                    : "which doesn't mention you"}
                .{" "}
                <Link href={`${base}/prompts`} className="font-semibold text-link underline">
                  Read every answer
                </Link>
              </footer>
            </blockquote>
          )}
        </>
      ),
    },
    {
      id: "fix",
      acuity: "20/30",
      question: "What to fix first",
      size: "text-[clamp(1.65rem,3vw,2.5rem)]",
      body:
        recommendations.length > 0 ? (
          <>
            {/* Ranked by the recommendations engine: a real sequence, so it is numbered. */}
            <ol className="flex flex-col gap-4">
              {recommendations.map((rec, index) => (
                <li key={rec.id} className="grid grid-cols-[2.25rem_1fr] items-baseline gap-3">
                  <span className="text-[28px] leading-none font-extrabold tabular-nums">{index + 1}</span>
                  <span>
                    <span className="text-lg font-bold">{rec.title}</span>
                    <span className="ml-2 text-sm text-muted-foreground">{rec.priority.toLowerCase()} priority</span>
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-6 text-sm">
              <Link href={`${base}/recommendations`} className="font-semibold text-link underline">
                All recommendations
              </Link>
            </p>
          </>
        ) : (
          <NotYet>No recommendations yet. They appear after your first crawl.</NotYet>
        ),
    },
    {
      id: "fine-print",
      acuity: "20/20",
      question: "The fine print",
      size: "text-[clamp(1.4rem,2.2vw,1.75rem)]",
      body: (
        <div className="flex flex-col gap-8">
          <dl className="grid grid-cols-2 gap-6 sm:grid-cols-3">
            <Figure label="Pages indexed" value={dashboard.indexedPages} />
            <Figure label="Trust" value={score?.scoreTrust ?? null} />
            <div>
              <dt className="text-sm text-muted-foreground">Score trend</dt>
              <dd className="mt-1">
                {dashboard.scoreTrend.length < 2 ? (
                  <span className="text-sm text-muted-foreground">A trend needs at least two crawls.</span>
                ) : (
                  <Sparkline points={dashboard.scoreTrend.map((point) => point.composite)} />
                )}
              </dd>
            </div>
          </dl>
          <p className="text-sm">
            {dashboard.comparisonSummary ? (
              <Link href={`${base}/comparison`} className="font-semibold text-link underline">
                Open the side-by-side competitor comparison
              </Link>
            ) : (
              <>
                <span className="text-muted-foreground">No competitor yet. </span>
                <Link href={`${base}/settings`} className="font-semibold text-link underline">
                  Add a competitor to compare
                </Link>
              </>
            )}
          </p>
          <p className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
            {[
              ["History", "history"],
              ["Crawls", "crawls"],
              ["Reports", "reports"],
              ["Settings", "settings"],
            ].map(([label, segment]) => (
              <Link key={segment} href={`${base}/${segment}`} className="font-semibold text-link underline">
                {label}
              </Link>
            ))}
          </p>
        </div>
      ),
    },
  ];
}

/**
 * Long domains are real (`northwind-industries-holdings-international.example.co.uk`), so
 * the title steps its size down with length rather than wrapping a name across six lines.
 */
function heroSizeFor(name: string): { className: string; px: number } {
  // `px` is each tier's typical rendered size, used to scale the blur.
  if (name.length <= 18) return { className: "text-[clamp(2.75rem,7vw,5.5rem)]", px: 76 };
  if (name.length <= 30) return { className: "text-[clamp(2.25rem,5vw,4rem)]", px: 56 };
  return { className: "text-[clamp(1.75rem,3.4vw,2.75rem)]", px: 40 };
}

/** Let a domain wrap after its dots and hyphens — never mid-label, unless a label alone is too wide. */
function withDomainBreaks(name: string): ReactNode[] {
  return name.split(/(?<=[.-])/).map((part, index) => (
    <span key={index}>
      {part}
      <wbr />
    </span>
  ));
}

function Verdict({ children }: { children: ReactNode }) {
  return <p className="text-[21px] leading-snug font-bold tracking-[-0.01em]">{children}</p>;
}

/** The one "not yet available" treatment (Frontend-Design §7): out of focus, with words. */
function NotYet({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-4">
      <span aria-hidden="true" className="out-of-focus text-[37px] leading-none font-extrabold">
        00
      </span>
      <span className="text-muted-foreground">{children}</span>
    </p>
  );
}

function Figure({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-1">
        {value === null ? (
          <span className="flex items-baseline gap-2">
            <span aria-hidden="true" className="out-of-focus text-[37px] leading-none font-extrabold">
              00
            </span>
            <span className="text-xs text-muted-foreground">not measured</span>
          </span>
        ) : (
          <span className="text-[37px] leading-none font-extrabold tracking-[-0.02em] tabular-nums">{value}</span>
        )}
      </dd>
    </div>
  );
}

function Sparkline({ points }: { points: number[] }) {
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const coords = points.map((value, index) => {
    const x = (index / (points.length - 1)) * 160;
    const y = 36 - ((value - min) / range) * 32;
    return `${x},${y}`;
  });

  return (
    <svg viewBox="0 0 160 40" className="h-10 w-40" preserveAspectRatio="none" role="img" aria-label="Score trend">
      <polyline
        points={coords.join(" ")}
        fill="none"
        stroke="var(--foreground)"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function CrawlStatusBadge({ status }: { status: CrawlStatus }) {
  const variant = status === "FAILED" ? "destructive" : status === "COMPLETED" ? "default" : "secondary";
  return <Badge variant={variant}>{status}</Badge>;
}

function pct(value: number | null): string {
  return value === null ? "an unmeasured share" : `${Math.round(value)}%`;
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
