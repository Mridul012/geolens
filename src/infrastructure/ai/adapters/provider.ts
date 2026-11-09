/**
 * The shape every provider adapter satisfies.
 *
 * Adapters are deliberately dumb: they send text and return text plus token counts. All
 * the judgement — tier resolution, schema validation, repair retries, budgets, metering,
 * tracing — lives in the gateway above them, so it is written once and cannot drift
 * between providers.
 */

export interface CompletionRequest {
  readonly model: string;
  readonly system: string;
  readonly user: string;
  readonly temperature: number;
  readonly maxOutputTokens: number;
  /** Ask the provider for JSON natively where it supports it. */
  readonly jsonMode: boolean;
  /** Mark the system prefix as cacheable where the provider supports it (§6). */
  readonly cacheSystemPrompt: boolean;
  readonly timeoutMs: number;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
}

export interface CompletionResult {
  readonly text: string;
  readonly usage: TokenUsage;
  /** Citations, for engines that return them natively (AI-Pipeline §4.3). */
  readonly citations: readonly string[];
}

export interface EmbeddingRequest {
  readonly model: string;
  readonly inputs: readonly string[];
  readonly timeoutMs: number;
}

export interface EmbeddingResult {
  readonly vectors: readonly (readonly number[])[];
  readonly inputTokens: number;
}

export interface ProviderAdapter {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
}

/** A provider refused or failed. The gateway decides whether that degrades or retries. */
export class ProviderError extends Error {
  readonly provider: string;
  /** True for timeouts, 429s and 5xx — the shapes worth retrying. */
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(
    provider: string,
    message: string,
    options: { retryable?: boolean; status?: number; cause?: unknown } = {},
  ) {
    super(`${provider}: ${message}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderError";
    this.provider = provider;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}

export class UnsupportedOperationError extends ProviderError {
  constructor(provider: string, operation: string) {
    super(provider, `does not support ${operation}`);
    this.name = "UnsupportedOperationError";
  }
}
