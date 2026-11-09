/**
 * The AI gateway — the only door to LLM and embedding providers (golden rule #1).
 *
 * Callers request a **tier**, never a model. Everything that makes AI spend safe and
 * auditable lives behind this interface: structured-output validation with one repair
 * retry, per-crawl budgets, the `ai_usage` ledger, and tracing. A model call that does not
 * go through here is a bug, and the boundary lint enforces it.
 */
import type { TierRequest } from "../../config/model-tiers.js";
import type { Result } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";

/** Cost attribution: every call is tagged so per-project economics are answerable. */
export interface AiCallContext {
  /** What this call is for — the `ai_usage.purpose` column. */
  readonly purpose: string;
  readonly projectId?: string | undefined;
  readonly crawlId?: string | undefined;
  readonly promptRunId?: string | undefined;
  /** Propagated from the originating request so a trace spans HTTP and worker. */
  readonly requestId?: string | undefined;
}

export interface StructuredRequest<T> {
  readonly tier: TierRequest;
  /** Versioned prompt id, e.g. `taxonomy/v1` — recorded on every row it influences. */
  readonly promptId: string;
  /** Stable across calls, so provider prompt caching can pay off (§6). */
  readonly systemPrompt: string;
  readonly userPrompt: string;
  /** The shape the model must return. Invalid output is repaired once, then fails. */
  readonly schema: {
    safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: unknown };
  };
  readonly context: AiCallContext;
  /** Relaxed deadlines may route through cheaper batch APIs (§7.3). */
  readonly deadline?: "realtime" | "relaxed";
}

export interface StructuredResponse<T> {
  /** Named `output` rather than `value` so `result.value.output` does not read as a typo. */
  readonly output: T;
  readonly model: string;
  readonly promptId: string;
  /** True when the first attempt failed validation and the repair retry succeeded. */
  readonly repaired: boolean;
  readonly costUsdMicros: bigint;
  readonly latencyMs: number;
}

/** Prompt simulation: the engine's answer *is* the measurement, so it is not schema-bound. */
export interface EngineRequest {
  readonly tier: `engine:${string}`;
  readonly prompt: string;
  readonly context: AiCallContext;
}

export interface EngineResponse {
  readonly answerText: string;
  /** Structured citations where the engine provides them (AI-Pipeline §4.3). */
  readonly citations: readonly string[];
  readonly model: string;
  readonly costUsdMicros: bigint;
  readonly latencyMs: number;
}

export interface EmbeddingRequest {
  readonly inputs: readonly string[];
  readonly context: AiCallContext;
}

export interface EmbeddingResponse {
  readonly vectors: readonly (readonly number[])[];
  readonly model: string;
  readonly dimensions: number;
  readonly costUsdMicros: bigint;
}

export interface AiGateway {
  /**
   * A schema-constrained completion.
   *
   * Failure is a typed error, never a guessed parse: one repair retry, then give up
   * (Engineering-Rules §6). Callers degrade — they never fabricate.
   */
  structured<T>(request: StructuredRequest<T>): Promise<Result<StructuredResponse<T>, AppError>>;

  /** An engine answer for prompt simulation. Never substituted across providers. */
  askEngine(request: EngineRequest): Promise<Result<EngineResponse, AppError>>;

  embed(request: EmbeddingRequest): Promise<Result<EmbeddingResponse, AppError>>;
}
