/**
 * Tier → model mapping. **The only place in the codebase a model name may appear**
 * (Engineering-Rules §6, §15.6 — grep-enforced in review).
 *
 * Callers request a tier, never a model. That indirection is what makes "providers change"
 * a config edit rather than a refactor, and it is the abstraction the PRD's provider-risk
 * mitigation rests on.
 *
 * Editing this file is a tripwire (§15.11): it requires a new version and a passing
 * `evals/run-golden`, because a changed model moves scores.
 */

export const TIERS = ["bulk", "judge", "frontier"] as const;
export type Tier = (typeof TIERS)[number];

/**
 * Engines are measurement subjects, not quality tiers (AI-Pipeline §1). An engine is never
 * substituted, never failed over, and never batched with different parameters — swapping
 * one changes *what we measured*, not how well we measured it.
 */
export const ENGINES = ["perplexity", "openai"] as const;
export type Engine = (typeof ENGINES)[number];

export type TierRequest = Tier | `engine:${Engine}`;

export type Provider = "openai" | "anthropic" | "groq" | "gemini" | "perplexity" | "fake";

export interface ModelSpec {
  readonly provider: Provider;
  readonly model: string;
  readonly temperature: number;
  readonly maxOutputTokens: number;
  /** USD per million input / output tokens, for the `ai_usage` ledger. */
  readonly inputCostPerMillion: number;
  readonly outputCostPerMillion: number;
  /** Provider prompt caching, where the shared prefix is worth marking (§6). */
  readonly supportsPromptCaching: boolean;
  /** Native JSON-schema-constrained output; otherwise we validate and repair. */
  readonly supportsStructuredOutput: boolean;
}

export interface EmbeddingSpec {
  readonly provider: Provider;
  readonly model: string;
  readonly dimensions: number;
  readonly costPerMillion: number;
  /** Provider cap on inputs per request. */
  readonly maxBatchSize: number;
}

/**
 * The default mapping.
 *
 * `bulk` is the workhorse — hundreds of calls per crawl, so it must be cheap and fast.
 * `judge` is mid-tier: answer-coverage decisions are worth more than per-page scoring.
 * `frontier` runs ~4 times per crawl on the outputs a human actually reads.
 */
const PRODUCTION_TIERS: Readonly<Record<Tier, ModelSpec>> = Object.freeze({
  bulk: {
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    temperature: 0,
    maxOutputTokens: 2_048,
    inputCostPerMillion: 0.59,
    outputCostPerMillion: 0.79,
    supportsPromptCaching: false,
    supportsStructuredOutput: true,
  },
  judge: {
    provider: "openai",
    model: "gpt-4o-mini",
    temperature: 0,
    maxOutputTokens: 1_024,
    inputCostPerMillion: 0.15,
    outputCostPerMillion: 0.6,
    supportsPromptCaching: true,
    supportsStructuredOutput: true,
  },
  frontier: {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    // Slight warmth: taxonomy and summaries read as prose, and 0 makes them wooden
    // (AI-Pipeline §1 allows 0.2–0.3 for this tier).
    temperature: 0.2,
    maxOutputTokens: 4_096,
    inputCostPerMillion: 3,
    outputCostPerMillion: 15,
    supportsPromptCaching: true,
    supportsStructuredOutput: true,
  },
});

const PRODUCTION_ENGINES: Readonly<Record<Engine, ModelSpec>> = Object.freeze({
  perplexity: {
    provider: "perplexity",
    model: "sonar",
    // Provider default: we are measuring the engine as a user experiences it.
    temperature: 0.2,
    maxOutputTokens: 2_048,
    inputCostPerMillion: 1,
    outputCostPerMillion: 1,
    supportsPromptCaching: false,
    supportsStructuredOutput: false,
  },
  openai: {
    provider: "openai",
    model: "gpt-4o-search-preview",
    temperature: 0.2,
    maxOutputTokens: 2_048,
    inputCostPerMillion: 2.5,
    outputCostPerMillion: 10,
    supportsPromptCaching: false,
    supportsStructuredOutput: false,
  },
});

const PRODUCTION_EMBEDDING: EmbeddingSpec = Object.freeze({
  provider: "openai",
  model: "text-embedding-3-small",
  // Fixed at 1536 by the `vector(1536)` column; changing it is a migration, not a config
  // edit (docs/Database.md §2.9).
  dimensions: 1_536,
  costPerMillion: 0.02,
  maxBatchSize: 256,
});

/**
 * Every tier answered by the deterministic fake adapter.
 *
 * This is what lets the whole pipeline run end to end with no API keys and no spend —
 * `AI_PROVIDER_MODE=fake` in local development and in CI. It is not a stub pretending to
 * be a model: it returns schema-valid, deterministic output so tests assert real pipeline
 * behaviour, and it is never selectable in production.
 */
const FAKE_SPEC: ModelSpec = Object.freeze({
  provider: "fake",
  model: "fake-deterministic-v1",
  temperature: 0,
  maxOutputTokens: 4_096,
  inputCostPerMillion: 0,
  outputCostPerMillion: 0,
  supportsPromptCaching: false,
  supportsStructuredOutput: true,
});

/**
 * Fake engines, one spec each.
 *
 * They differ only in the model string, and that difference is load-bearing: `ai_usage`
 * records the model, so a shared name would make per-engine cost attribution impossible in
 * a keyless run — and would leave anything downstream unable to tell which engine answered.
 */
const FAKE_ENGINE_SPECS: Readonly<Record<Engine, ModelSpec>> = Object.freeze({
  perplexity: Object.freeze({ ...FAKE_SPEC, model: "fake-engine-perplexity" }),
  openai: Object.freeze({ ...FAKE_SPEC, model: "fake-engine-openai" }),
});

const FAKE_EMBEDDING: EmbeddingSpec = Object.freeze({
  provider: "fake",
  model: "fake-embedding-v1",
  dimensions: 1_536,
  costPerMillion: 0,
  maxBatchSize: 256,
});

export type ProviderMode = "live" | "fake";

export interface TierConfig {
  readonly version: string;
  readonly mode: ProviderMode;
  readonly tiers: Readonly<Record<Tier, ModelSpec>>;
  readonly engines: Readonly<Record<Engine, ModelSpec>>;
  readonly embedding: EmbeddingSpec;
}

export function tierConfigFor(mode: ProviderMode): TierConfig {
  if (mode === "fake") {
    return {
      version: "v1-fake",
      mode,
      tiers: { bulk: FAKE_SPEC, judge: FAKE_SPEC, frontier: FAKE_SPEC },
      engines: FAKE_ENGINE_SPECS,
      embedding: FAKE_EMBEDDING,
    };
  }
  return {
    version: "v1",
    mode,
    tiers: PRODUCTION_TIERS,
    engines: PRODUCTION_ENGINES,
    embedding: PRODUCTION_EMBEDDING,
  };
}

/** Resolves a tier request to its model spec. */
export function resolveSpec(config: TierConfig, request: TierRequest): ModelSpec {
  if (request.startsWith("engine:")) {
    const engine = request.slice("engine:".length) as Engine;
    const spec = config.engines[engine];
    if (spec === undefined) throw new Error(`Unknown engine: ${engine}`);
    return spec;
  }
  const spec = config.tiers[request as Tier];
  if (spec === undefined) throw new Error(`Unknown tier: ${request}`);
  return spec;
}

/** Cost in integer micro-USD — money is never a float (docs/Database.md §1.7). */
export function costMicrosFor(
  spec: Pick<ModelSpec, "inputCostPerMillion" | "outputCostPerMillion">,
  usage: { readonly inputTokens: number; readonly outputTokens: number },
): bigint {
  const inputMicros = (usage.inputTokens * spec.inputCostPerMillion) / 1_000_000 * 1_000_000;
  const outputMicros = (usage.outputTokens * spec.outputCostPerMillion) / 1_000_000 * 1_000_000;
  return BigInt(Math.round(inputMicros + outputMicros));
}

export function embeddingCostMicros(spec: EmbeddingSpec, tokens: number): bigint {
  return BigInt(Math.round((tokens * spec.costPerMillion) / 1_000_000 * 1_000_000));
}
