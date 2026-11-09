"use client";

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Comparison } from "@contracts/api/comparison";
import { apiFetch } from "@/lib/api/client";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type ComparisonSide = Comparison["own"];
type ComparisonMetrics = ComparisonSide["metrics"];
type ShareOfVoice = Comparison["shareOfVoice"];
type MissingTopics = Comparison["missingTopics"];

const METRICS: { key: keyof ComparisonMetrics; label: string }[] = [
  { key: "aiVisibility", label: "AI Visibility" },
  { key: "topicCoverage", label: "Topic Coverage" },
  { key: "authority", label: "Authority" },
  { key: "contentFreshness", label: "Content Freshness" },
  { key: "pageCount", label: "Page Count" },
  { key: "blogCoverage", label: "Blog Coverage" },
  { key: "trustSignals", label: "Trust Signals" },
];

export function ComparisonView({
  projectId,
  initialComparison,
}: {
  projectId: string;
  initialComparison: Comparison;
}) {
  const { data: comparison } = useQuery({
    queryKey: ["comparison", projectId],
    queryFn: () => apiFetch<Comparison>(`/v1/projects/${projectId}/comparison`),
    initialData: initialComparison,
  });

  return (
    <div className="flex flex-col gap-6 p-10">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Competitor Comparison</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          See how {comparison.own.name ?? comparison.own.domain} stacks up against the competitor
          you track.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <SideCard title="Your site" side={comparison.own} />
        {comparison.competitor === null ? (
          <EmptyCompetitorCard />
        ) : (
          <SideCard title="Competitor" side={comparison.competitor} />
        )}
      </div>

      <ShareOfVoiceCard shareOfVoice={comparison.shareOfVoice} />

      <MissingTopicsCard topics={comparison.missingTopics} />
    </div>
  );
}

function SideCard({ title, side }: { title: string; side: ComparisonSide }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
      <SectionLabel>{title}</SectionLabel>
      <p className="mt-1 text-lg font-extrabold">{side.name ?? side.domain}</p>
      <p className="text-xs text-muted-foreground">{side.domain}</p>

      {side.crawlId === null && (
        <p className="mt-3 text-xs text-muted-foreground">
          Not yet crawled — metrics will appear once a crawl completes.
        </p>
      )}

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {METRICS.map(({ key, label }) => {
          const value = side.metrics[key];
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
              <span
                className={
                  value === null
                    ? "text-xl font-extrabold text-muted-foreground/50"
                    : "text-xl font-extrabold"
                }
              >
                {value ?? "—"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EmptyCompetitorCard() {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-border bg-secondary/40 p-8 text-center">
      <p className="text-lg font-bold">No competitor tracked</p>
      <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground">
        Add a competitor to unlock comparison.
      </p>
    </div>
  );
}

function ShareOfVoiceCard({ shareOfVoice }: { shareOfVoice: ShareOfVoice }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
      <SectionLabel>Share of voice</SectionLabel>
      {shareOfVoice === null ? (
        <NotYetMeasured caption="not yet measured — run prompt tracking to see share of voice" />
      ) : (
        <div className="mt-3 flex flex-col gap-5">
          <Stat value={formatPercent(shareOfVoice.overall)} label="overall share of voice" />

          {shareOfVoice.perEngine.length > 0 && (
            <div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Engine</TableHead>
                    <TableHead className="text-right">Your citations</TableHead>
                    <TableHead className="text-right">Competitor citations</TableHead>
                    <TableHead className="text-right">Share of voice</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shareOfVoice.perEngine.map((row) => (
                    <TableRow key={row.engine}>
                      <TableCell className="font-semibold">{row.engine}</TableCell>
                      <TableCell className="text-right">{row.ownCitations}</TableCell>
                      <TableCell className="text-right">{row.competitorCitations}</TableCell>
                      <TableCell className="text-right">
                        {row.shareOfVoice === null ? (
                          <span className="text-muted-foreground/50">—</span>
                        ) : (
                          `${Math.round(row.shareOfVoice)}%`
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {Object.keys(shareOfVoice.competitorCitations).length > 0 && (
            <div>
              <SectionLabel>Competitor citations</SectionLabel>
              <div className="mt-2 flex flex-col">
                {Object.entries(shareOfVoice.competitorCitations).map(([name, count]) => (
                  <div
                    key={name}
                    className="flex items-center justify-between border-b border-border py-2 text-sm last:border-none"
                  >
                    <span className="font-semibold">{name}</span>
                    <span className="text-muted-foreground">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MissingTopicsCard({ topics }: { topics: MissingTopics }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
      <SectionLabel>Missing topics</SectionLabel>
      {topics.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No coverage gaps found.</p>
      ) : (
        <div className="mt-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Topic</TableHead>
                <TableHead className="text-right">Gap</TableHead>
                <TableHead className="text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {topics.map((topic) => (
                <TableRow key={topic.topicId}>
                  <TableCell className="font-semibold">{topic.label}</TableCell>
                  <TableCell className="text-right">
                    {topic.gap === null ? (
                      <span className="text-muted-foreground/50">—</span>
                    ) : (
                      topic.gap
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {topic.missing && <Badge variant="destructive">missing</Badge>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
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
    <div className="mt-3 flex items-center gap-3 rounded-xl border-2 border-dashed border-border bg-secondary/50 px-4 py-3">
      <span className="text-lg font-extrabold text-muted-foreground/50">—</span>
      <span className="text-xs text-muted-foreground">{caption}</span>
    </div>
  );
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
