"use client";

import { useState } from "react";
import type { PromptRunTrend } from "@contracts/api/prompt-runs";
import { cn } from "@/lib/utils";

type Metric = "mentionRate" | "citationShare";
type TrendPoint = PromptRunTrend["data"][number];

const METRICS: ReadonlyArray<{ id: Metric; label: string }> = [
  { id: "mentionRate", label: "Mention rate" },
  { id: "citationShare", label: "Citation share" },
];

const ENGINE_LABELS: Record<string, string> = { perplexity: "Perplexity", openai: "ChatGPT" };
const ENGINE_COLORS = ["var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

interface Series {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly values: ReadonlyArray<number | null>;
  readonly emphasis: boolean;
}

/**
 * Mention rate / citation share per prompt run, oldest → newest, overall and per engine.
 * A run that could not measure a metric leaves a gap — never a drop to zero.
 */
export function PromptTrendChart({ trend }: { trend: PromptRunTrend["data"] }) {
  const [metric, setMetric] = useState<Metric>("mentionRate");

  if (trend.length < 2) {
    return (
      <p className="mt-3 text-sm text-muted-foreground">
        The trend appears after two prompt runs — one run is a snapshot, not a direction.
      </p>
    );
  }

  const series = buildSeries(trend, metric);

  return (
    <div className="mt-3 flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Metric" className="flex gap-1 rounded-xl bg-secondary p-1">
          {METRICS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              aria-pressed={metric === id}
              onClick={() => setMetric(id)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-xs font-semibold",
                metric === id
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <ul className="flex flex-wrap gap-4 text-xs text-muted-foreground">
          {series.map((line) => (
            <li key={line.key} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: line.color }} />
              {line.label}
            </li>
          ))}
        </ul>
      </div>

      {/* Labels are HTML so they keep their size; only the plot stretches to the card. */}
      <div className="flex gap-3">
        <div className="relative h-44 w-9 shrink-0 text-right text-[11px] text-muted-foreground">
          {[100, 50, 0].map((tick) => (
            <span
              key={tick}
              className="absolute right-0 -translate-y-1/2"
              style={{ top: `${100 - tick}%` }}
            >
              {tick}%
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="h-44 w-full overflow-visible"
            role="img"
            aria-label={`${METRICS.find((m) => m.id === metric)?.label} across ${trend.length} prompt runs`}
          >
            {[0, 50, 100].map((tick) => (
              <line
                key={tick}
                x1={0}
                x2={100}
                y1={yFor(tick)}
                y2={yFor(tick)}
                stroke="var(--border)"
                strokeDasharray={tick === 0 ? undefined : "3 4"}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {series.map((line) =>
              segments(line.values).map((segment, index) => (
                // A lone measured run is a zero-length line with round caps: a dot that,
                // unlike a <circle>, stays round when the plot is stretched.
                <polyline
                  key={`${line.key}-${index}`}
                  data-series={line.key}
                  {...(segment.length === 1 ? { "data-lone": "" } : {})}
                  points={(segment.length === 1 ? [segment[0]!, segment[0]!] : segment)
                    .map((point) => `${xFor(point.index, trend.length)},${yFor(point.value)}`)
                    .join(" ")}
                  fill="none"
                  stroke={line.color}
                  strokeWidth={segment.length === 1 ? 7 : line.emphasis ? 2.5 : 1.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              )),
            )}
          </svg>
          <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
            <span suppressHydrationWarning>{shortDate(trend[0]!.at)}</span>
            <span suppressHydrationWarning>{shortDate(trend[trend.length - 1]!.at)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function buildSeries(trend: PromptRunTrend["data"], metric: Metric): Series[] {
  const engines = [...new Set(trend.flatMap((point) => point.perEngine.map((e) => e.engine)))];
  return [
    {
      key: "overall",
      label: "All engines",
      color: "var(--chart-1)",
      values: trend.map((point) => point[metric]),
      emphasis: true,
    },
    ...engines.map((engine, index) => ({
      key: engine,
      label: ENGINE_LABELS[engine] ?? engine,
      color: ENGINE_COLORS[index % ENGINE_COLORS.length]!,
      values: trend.map((point: TrendPoint) => {
        const entry = point.perEngine.find((e) => e.engine === engine);
        return entry ? entry[metric] : null;
      }),
      emphasis: false,
    })),
  ];
}

/** Consecutive measured points; a null splits the line so a gap stays a gap. */
export function segments(
  values: ReadonlyArray<number | null>,
): Array<Array<{ index: number; value: number }>> {
  const result: Array<Array<{ index: number; value: number }>> = [];
  let current: Array<{ index: number; value: number }> = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length > 0) result.push(current);
      current = [];
    } else {
      current.push({ index, value });
    }
  });
  if (current.length > 0) result.push(current);
  return result;
}

/** Plot coordinates are 0–100 on both axes; the SVG stretches them to the card. */
function xFor(index: number, count: number): number {
  return (index / (count - 1)) * 100;
}

function yFor(percent: number): number {
  return 100 - Math.min(100, Math.max(0, percent));
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
