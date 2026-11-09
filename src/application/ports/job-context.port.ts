/**
 * The contract between the queue runtime and a processor.
 *
 * Processors are edges, so they may not import the queue library; the runtime satisfies
 * this interface and hands it in. Keeping it here is what lets a processor be unit-tested
 * with a plain object.
 */
export interface JobLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  debug(obj: Record<string, unknown>, msg?: string): void;
  child(bindings: Record<string, unknown>): JobLogger;
}

export interface JobContext {
  readonly jobId: string;
  readonly attempt: number;
  readonly log: JobLogger;
  /** True once shutdown has begun; long jobs check this at safe points. */
  readonly shouldStop: () => boolean;
  readonly reportProgress: (progress: unknown) => Promise<void>;
}
