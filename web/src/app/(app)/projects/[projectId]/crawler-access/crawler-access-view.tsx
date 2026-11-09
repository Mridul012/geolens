"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CheckCircle2Icon,
  ClockIcon,
  CopyIcon,
  FileTextIcon,
  ShieldCheckIcon,
  ShieldOffIcon,
  XCircleIcon,
} from "lucide-react";
import type { ProjectDetail } from "@contracts/api/projects";
import type { AccessCheck, AnalysisReport } from "@contracts/api/analysis";
import type { CrawlStatus } from "@contracts/api/crawls";
import { apiFetch } from "@/lib/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

type BotFinding = AccessCheck["bots"][number];

const IN_FLIGHT: CrawlStatus[] = ["QUEUED", "CRAWLING", "ANALYZING"];
const READY: CrawlStatus[] = ["COMPLETED", "COMPLETED_DEGRADED"];

// A confident, distinct green for "allowed" states — the design system only defines
// primary/secondary/destructive tokens (see globals.css), so this follows the same ad hoc
// oklch pattern dashboard-view.tsx uses for its degradation banner.
const ALLOWED_BADGE_CLASS = "border-transparent bg-[oklch(0.91_0.07_150)] text-[oklch(0.35_0.1_150)]";

export function CrawlerAccessView({
  projectId,
  initialProject,
  initialAccessCheck,
}: {
  projectId: string;
  initialProject: ProjectDetail;
  initialAccessCheck: AccessCheck | null;
}) {
  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => apiFetch<ProjectDetail>(`/v1/projects/${projectId}`),
    initialData: initialProject,
    refetchInterval: (query) => {
      const status = query.state.data?.latestCrawl?.status;
      return status && IN_FLIGHT.includes(status) ? 3000 : false;
    },
  });

  const latestCrawl = project.latestCrawl;
  const isReady = latestCrawl !== null && READY.includes(latestCrawl.status);
  const crawlId = isReady ? latestCrawl.id : undefined;

  const {
    data: accessCheck,
    isError: accessCheckErrored,
  } = useQuery({
    queryKey: ["crawler-access", projectId, crawlId],
    queryFn: async () => {
      const analysis = await apiFetch<AnalysisReport>(
        `/v1/projects/${projectId}/crawls/${crawlId}/analysis`,
      );
      return analysis.accessCheck;
    },
    initialData: initialAccessCheck,
    enabled: isReady,
  });

  return (
    <div className="flex flex-col gap-6 p-10">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">AI Crawler Access</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Whether ChatGPT, Perplexity, and other AI engines can actually reach and read your
          site.
        </p>
      </div>

      {accessCheckErrored && (
        <Alert variant="destructive">
          <AlertDescription>
            Couldn&apos;t load the access check. Try refreshing the page.
          </AlertDescription>
        </Alert>
      )}

      {latestCrawl === null ? (
        <NoCrawlState projectId={projectId} />
      ) : IN_FLIGHT.includes(latestCrawl.status) ? (
        <InProgressState status={latestCrawl.status} />
      ) : !isReady ? (
        <UnavailableState status={latestCrawl.status} projectId={projectId} />
      ) : accessCheck === null ? (
        <PendingAccessCheckState />
      ) : (
        <ReadyState accessCheck={accessCheck} />
      )}
    </div>
  );
}

function ReadyState({ accessCheck }: { accessCheck: AccessCheck }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <AllowedShareCard allowedShare={accessCheck.allowedShare} />
        <LlmsTxtCard llmsTxt={accessCheck.llmsTxt} />
        <RobotsTxtCard present={accessCheck.robotsTxtPresent} />
      </div>

      <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <SectionLabel>Bot-by-bot access</SectionLabel>
          <span className="text-xs text-muted-foreground">
            Checked {formatCheckedAt(accessCheck.checkedAt)}
          </span>
        </div>
        {accessCheck.bots.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No bot findings recorded.</p>
        ) : (
          <div className="mt-3 flex flex-col">
            {accessCheck.bots.map((bot) => (
              <BotRow key={bot.bot} bot={bot} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AllowedShareCard({ allowedShare }: { allowedShare: number }) {
  const circumference = 2 * Math.PI * 54;
  const dash = (allowedShare / 100) * circumference;

  return (
    <div className="flex items-center gap-6 rounded-2xl border border-border bg-card p-6 shadow-sm">
      <div className="relative h-28 w-28 shrink-0">
        <svg viewBox="0 0 128 128" className="h-28 w-28 -rotate-90">
          <circle cx="64" cy="64" r="54" fill="none" stroke="var(--secondary)" strokeWidth={12} />
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
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-3xl font-extrabold tracking-tight">{allowedShare}%</span>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-bold tracking-wide text-muted-foreground uppercase">
          AI crawlers allowed
        </span>
        <span className="text-xs text-muted-foreground">
          Share of tracked bots that can read your site
        </span>
      </div>
    </div>
  );
}

function LlmsTxtCard({ llmsTxt }: { llmsTxt: AccessCheck["llmsTxt"] }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <SectionLabel>llms.txt</SectionLabel>
        <FileTextIcon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {llmsTxt.present ? (
          <Badge className={`gap-1 ${ALLOWED_BADGE_CLASS}`}>
            <CheckCircle2Icon className="h-3 w-3" />
            Present
          </Badge>
        ) : (
          <Badge variant="destructive" className="gap-1">
            <XCircleIcon className="h-3 w-3" />
            Missing
          </Badge>
        )}
        {llmsTxt.present && llmsTxt.valid !== null && (
          <Badge variant={llmsTxt.valid ? "secondary" : "destructive"}>
            {llmsTxt.valid ? "Valid" : "Invalid"}
          </Badge>
        )}
      </div>
      {llmsTxt.issues.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1 text-xs text-muted-foreground">
          {llmsTxt.issues.map((issue, index) => (
            <li key={`${index}-${issue}`}>• {issue}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RobotsTxtCard({ present }: { present: boolean }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <SectionLabel>robots.txt</SectionLabel>
        {present ? (
          <ShieldCheckIcon className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ShieldOffIcon className="h-4 w-4 text-muted-foreground" />
        )}
      </div>
      <div className="mt-3">
        {present ? (
          <Badge className={`gap-1 ${ALLOWED_BADGE_CLASS}`}>
            <CheckCircle2Icon className="h-3 w-3" />
            Present
          </Badge>
        ) : (
          <Badge variant="destructive" className="gap-1">
            <XCircleIcon className="h-3 w-3" />
            Missing
          </Badge>
        )}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {present
          ? "A robots.txt file was found at the site root."
          : "No robots.txt file was found — AI crawlers default to allowed, but you have no explicit control."}
      </p>
    </div>
  );
}

function BotRow({ bot }: { bot: BotFinding }) {
  return (
    <div className="flex flex-col gap-2 border-b border-border py-4 last:border-none">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="text-sm font-bold">{bot.bot}</span>
          <span className="text-xs text-muted-foreground">{bot.operator}</span>
        </div>
        {bot.allowed ? (
          <Badge className={`shrink-0 gap-1 ${ALLOWED_BADGE_CLASS}`}>
            <CheckCircle2Icon className="h-3 w-3" />
            Allowed
          </Badge>
        ) : (
          <Badge variant="destructive" className="shrink-0 gap-1">
            <XCircleIcon className="h-3 w-3" />
            Blocked{bot.blockedBy ? ` by ${bot.blockedBy === "robots" ? "robots.txt" : "CDN"}` : ""}
          </Badge>
        )}
      </div>

      {bot.evidence && (
        <p className="text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">Evidence: </span>
          <code className="rounded bg-secondary px-1 py-0.5 text-[11px]">{bot.evidence}</code>
        </p>
      )}

      {bot.impact && <p className="text-xs text-muted-foreground">{bot.impact}</p>}

      {bot.fix && <FixSnippet fix={bot.fix} />}
    </div>
  );
}

function FixSnippet({ fix }: { fix: string }) {
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(fix);
      toast.success("Copied");
    } catch {
      toast.error("Couldn't copy — copy it manually.");
    }
  };

  return (
    <div className="relative mt-1 overflow-hidden rounded-lg border border-border bg-secondary/60">
      <pre className="overflow-x-auto p-3 pr-20 text-xs">
        <code>{fix}</code>
      </pre>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="absolute top-1.5 right-1.5"
        onClick={handleCopy}
      >
        <CopyIcon className="h-3.5 w-3.5" />
        Copy
      </Button>
    </div>
  );
}

function NoCrawlState({ projectId }: { projectId: string }) {
  return (
    <EmptyStateCard
      icon={<ShieldOffIcon className="h-4.5 w-4.5" />}
      title="No crawl yet"
      description="Start a crawl from the dashboard to check whether AI crawlers can access your site."
    >
      <Button render={<Link href={`/projects/${projectId}`} />} nativeButton={false}>Go to dashboard →</Button>
    </EmptyStateCard>
  );
}

function InProgressState({ status }: { status: CrawlStatus }) {
  return (
    <EmptyStateCard
      icon={<ClockIcon className="h-4.5 w-4.5" />}
      title="Still analyzing — check back shortly"
      description={`Your crawl is ${status.toLowerCase()}. This page updates automatically once it finishes.`}
    />
  );
}

function UnavailableState({ status, projectId }: { status: CrawlStatus; projectId: string }) {
  return (
    <EmptyStateCard
      icon={<XCircleIcon className="h-4.5 w-4.5" />}
      title={status === "FAILED" ? "Latest crawl failed" : "Latest crawl was canceled"}
      description="Start a new crawl from the dashboard to check AI crawler access."
    >
      <Button render={<Link href={`/projects/${projectId}`} />} nativeButton={false}>Go to dashboard →</Button>
    </EmptyStateCard>
  );
}

function PendingAccessCheckState() {
  return (
    <EmptyStateCard
      icon={<ClockIcon className="h-4.5 w-4.5" />}
      title="Access check pending"
      description="The crawl finished, but the AI crawler access check hasn't produced results yet — check back shortly."
    />
  );
}

function EmptyStateCard({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-2xl border-2 border-dashed border-border bg-secondary/40 p-8">
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-secondary text-muted-foreground">
        {icon}
      </span>
      <div>
        <p className="text-lg font-bold">{title}</p>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
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

function formatCheckedAt(iso: string): string {
  // Pinned locale — an SSR'd client component must render the exact same string on the
  // server and in the browser, and `undefined` resolves to each environment's own default.
  return new Date(iso).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
