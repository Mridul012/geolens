/**
 * Job payload contracts.
 *
 * A queue is a deploy boundary: the producer and the consumer can be running different
 * versions of the code at the same moment. Payloads are therefore validated **twice** —
 * once at enqueue, once at dequeue (Engineering-Rules §7) — against these schemas.
 */
import { z } from "zod";

export const crawlJobSchema = z.object({
  crawlId: z.string().uuid(),
  projectId: z.string().uuid(),
  siteId: z.string().uuid(),
  trigger: z.enum(["MANUAL", "SCHEDULED"]),
  /** Propagated from the originating request so logs correlate end to end (§4). */
  requestId: z.string().optional(),
});
export type CrawlJob = z.infer<typeof crawlJobSchema>;

/**
 * One batch of page snapshots to chunk and embed (M10).
 *
 * Snapshot ids rather than a page range: the batch must stay stable across a retry, and a
 * range would silently re-index different pages if the crawl were still writing.
 */
export const indexJobSchema = z.object({
  crawlId: z.string().uuid(),
  projectId: z.string().uuid(),
  siteId: z.string().uuid(),
  snapshotIds: z.array(z.string().uuid()).min(1),
  requestId: z.string().optional(),
});
export type IndexJob = z.infer<typeof indexJobSchema>;

/**
 * A per-crawl analysis step that runs once the index children have settled.
 *
 * `task` is a closed union rather than a free string so a typo cannot enqueue work that
 * silently does nothing.
 */
export const analyzeJobSchema = z.object({
  crawlId: z.string().uuid(),
  projectId: z.string().uuid(),
  siteId: z.string().uuid(),
  task: z.enum(["topic-coverage", "retrievability", "page-quality"]),
  requestId: z.string().optional(),
});
export type AnalyzeJob = z.infer<typeof analyzeJobSchema>;

/**
 * The fan-in parent (docs/Backend.md §4.1): runs only after every child has settled, and
 * owns the crawl's terminal state.
 *
 * It carries no statistics — those live on the crawl row, and a payload copy would be a
 * second version of the truth that could disagree with the first.
 */
export const aggregateJobSchema = z.object({
  crawlId: z.string().uuid(),
  projectId: z.string().uuid(),
  siteId: z.string().uuid(),
  requestId: z.string().optional(),
});
export type AggregateJob = z.infer<typeof aggregateJobSchema>;

/**
 * One prompt run (M15).
 *
 * The engines are carried on the payload rather than re-read at execution: a run is a
 * measurement, and which engines it covered must be fixed at the moment it was triggered,
 * not at whatever the config said when the worker picked it up.
 */
export const promptSimJobSchema = z.object({
  runId: z.string().uuid(),
  projectId: z.string().uuid(),
  engines: z.array(z.enum(["perplexity", "openai"])).min(1),
  requestId: z.string().optional(),
});
export type PromptSimJob = z.infer<typeof promptSimJobSchema>;

/**
 * PDF generation (M17). Carries no snapshot data: the report row already pins the crawl
 * and prompt run it is about, and re-reading them here would let a retried job render
 * against whatever became "latest" in the meantime instead of what was promised at 202.
 */
export const reportJobSchema = z.object({
  reportId: z.string().uuid(),
  projectId: z.string().uuid(),
  requestId: z.string().optional(),
});
export type ReportJob = z.infer<typeof reportJobSchema>;

export const purgeProjectJobSchema = z.object({
  projectId: z.string().uuid(),
  requestId: z.string().optional(),
});
export type PurgeProjectJob = z.infer<typeof purgeProjectJobSchema>;

/**
 * `housekeeping` also carries the M18 scheduler ticks: each is a no-payload task run once
 * per fire, batch-processing whatever is eligible rather than fanning out one job per
 * entity — the same shape as `sweep-deleted-projects`.
 */
export const housekeepingJobSchema = z.discriminatedUnion("task", [
  z.object({ task: z.literal("purge-project"), payload: purgeProjectJobSchema }),
  z.object({ task: z.literal("sweep-deleted-projects") }),
  z.object({ task: z.literal("schedule-weekly-crawls") }),
  z.object({ task: z.literal("schedule-weekly-prompt-runs") }),
  z.object({ task: z.literal("schedule-weekly-digests") }),
  z.object({ task: z.literal("usage-rollup") }),
  z.object({ task: z.literal("sweep-failed-jobs") }),
  z.object({ task: z.literal("budget-monitor") }),
]);
export type HousekeepingJob = z.infer<typeof housekeepingJobSchema>;

/**
 * Notification sends (M18). The `notify` queue is I/O-bound (an email API call), so it
 * lives in the AI pool alongside the other non-browser queues, retried on the same policy
 * as everything else that talks to a third party.
 */
export const notifyJobSchema = z.discriminatedUnion("task", [
  z.object({
    task: z.literal("crawl-complete"),
    payload: z.object({ projectId: z.string().uuid(), crawlId: z.string().uuid() }),
  }),
  z.object({
    task: z.literal("weekly-digest"),
    payload: z.object({ projectId: z.string().uuid() }),
  }),
]);
export type NotifyJob = z.infer<typeof notifyJobSchema>;

/** Every queue's payload schema, keyed by queue name. */
export const JOB_SCHEMAS = {
  crawl: crawlJobSchema,
  index: indexJobSchema,
  analyze: analyzeJobSchema,
  aggregate: aggregateJobSchema,
  "prompt-sim": promptSimJobSchema,
  report: reportJobSchema,
  notify: notifyJobSchema,
  housekeeping: housekeepingJobSchema,
} as const;

export type JobPayloads = {
  readonly crawl: CrawlJob;
  readonly index: IndexJob;
  readonly analyze: AnalyzeJob;
  readonly aggregate: AggregateJob;
  readonly "prompt-sim": PromptSimJob;
  readonly report: ReportJob;
  readonly notify: NotifyJob;
  readonly housekeeping: HousekeepingJob;
};

/**
 * Deterministic job ids — re-delivery can never double-write (Engineering-Rules §7).
 *
 * The docs write these as `crawl:{crawlId}`; BullMQ v5 rejects a custom id containing `:`
 * (it is the library's own key separator), so the same scheme uses `-`. The property that
 * matters — one id per logical unit of work, derived from the entity — is unchanged.
 */
export const jobId = {
  crawl: (crawlId: string): string => `crawl-${crawlId}`,
  index: (crawlId: string, batch: number): string => `index-${crawlId}-${batch}`,
  analyze: (crawlId: string, task: AnalyzeJob["task"]): string => `analyze-${crawlId}-${task}`,
  aggregate: (crawlId: string): string => `aggregate-${crawlId}`,
  promptSim: (runId: string): string => `prompt-sim-${runId}`,
  report: (reportId: string): string => `report-${reportId}`,
  purgeProject: (projectId: string): string => `purge-${projectId}`,
  sweepDeletedProjects: (isoDay: string): string => `sweep-${isoDay}`,
  notifyCrawlComplete: (crawlId: string): string => `notify-crawl-${crawlId}`,
  /** One per project per ISO week — enqueuing twice for the same week is a safe no-op. */
  notifyDigest: (projectId: string, isoWeek: string): string => `notify-digest-${projectId}-${isoWeek}`,
} as const;
