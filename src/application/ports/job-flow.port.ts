/**
 * Fan-out/fan-in behind a port (docs/Backend.md §4.1, Engineering-Rules §2.2).
 *
 * A flow is a tree of jobs where a parent runs only once every descendant has settled.
 * The analysis pipeline is exactly that shape: chunk and embed the changed pages in
 * parallel, then map topics over the finished corpus, then finalize the crawl.
 *
 * Use cases describe the tree; they never learn that BullMQ calls this a Flow, and they
 * never see a `FlowProducer`.
 */
import type { JobPayloads } from "../../contracts/jobs/index.js";

/** One node of the tree: a job, plus the jobs that must finish before it runs. */
export type FlowNode = {
  readonly [Q in keyof JobPayloads]: {
    readonly queue: Q;
    readonly payload: JobPayloads[Q];
    /** Deterministic, so a re-submitted flow cannot duplicate work (§7). */
    readonly jobId: string;
    readonly priority?: number;
    /** Children run first; the node itself waits for all of them. */
    readonly children?: readonly FlowNode[];
  };
}[keyof JobPayloads];

export interface JobFlow {
  /**
   * Submits a tree for execution.
   *
   * Resubmitting an identical tree is a no-op for any node still queued or active, the
   * same guarantee `JobQueue.enqueue` gives for a single job.
   */
  submit(root: FlowNode): Promise<void>;
}
