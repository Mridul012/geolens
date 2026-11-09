/**
 * A scripted engine, for prompt-simulation tests.
 *
 * The shipped `FakeAdapter` deliberately names no vendor — it has no knowledge of who a
 * real assistant would recommend, and inventing one would fabricate the number the product
 * exists to measure. That honesty makes it useless for testing the *parser*, which needs
 * answers that actually mention and cite.
 *
 * So this one returns fixture answers covering the matrix the milestone names: mentioned
 * and cited, mentioned only, competitor-only, neither, and the ambiguous case that has to
 * escalate to the judge. Everything downstream of the answer — parsing, aggregation,
 * scoring, storage — is the real code.
 */
import type {
  CompletionRequest,
  CompletionResult,
  EmbeddingRequest,
  EmbeddingResult,
  ProviderAdapter,
} from "../../src/infrastructure/ai/adapters/provider.js";
import { FakeAdapter } from "../../src/infrastructure/ai/adapters/fake.adapter.js";

export type AnswerKind =
  | "mentioned-and-cited"
  | "mentioned-only"
  | "competitor-only"
  | "neither"
  | "ambiguous";

export const SCRIPTED_ANSWERS: Readonly<Record<AnswerKind, string>> = Object.freeze({
  "mentioned-and-cited":
    "For small finance teams, Acme Analytics is the usual recommendation. Their pricing is public at https://acme.com/pricing and the docs are good.",
  "mentioned-only":
    "Acme Analytics comes up often in this category, though I do not have a link to hand.",
  "competitor-only":
    "Rivalcorp is the established option here; see https://rival.com/pricing for their plans.",
  neither:
    "Most teams start with a spreadsheet and move to a dedicated tool once the volume justifies it.",
  ambiguous:
    "You should keep the acme of simplicity in mind when choosing; the acme approach favours fewer tools.",
});

export interface ScriptedEngineOptions {
  /** Answer kind per (engine, sampleIndex) — anything unspecified falls back to `fallback`. */
  readonly script?: (context: { engine: string; prompt: string; call: number }) => AnswerKind;
  readonly fallback?: AnswerKind;
  /** Engines that fail every call, for the degraded-run path. */
  readonly failingEngines?: readonly string[];
}

/**
 * Which engine a call is for.
 *
 * Read off the model the tier resolved to — `fake-engine-perplexity`, `fake-engine-openai`.
 * An earlier version counted calls and alternated, which silently mislabelled every cell
 * the moment the run's loop order changed; the model name is the only thing that actually
 * identifies the engine at the adapter boundary.
 */
export class ScriptedEngineAdapter implements ProviderAdapter {
  readonly name = "fake";
  readonly #inner = new FakeAdapter();
  readonly #options: ScriptedEngineOptions;
  readonly #engines: readonly string[];
  #engineCalls = 0;

  constructor(engines: readonly string[], options: ScriptedEngineOptions = {}) {
    this.#engines = engines;
    this.#options = options;
  }

  #engineOf(model: string): string {
    const named = this.#engines.find((engine) => model.endsWith(engine));
    return named ?? model;
  }

  /** Calls made per engine, so a test can assert the run covered every cell. */
  readonly perEngine = new Map<string, number>();

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    // Anything with a system prompt is a structured call — the judge, in practice.
    if (request.system.length > 0) return this.#inner.complete(request);

    const engine = this.#engineOf(request.model);
    const call = this.#engineCalls;
    this.#engineCalls += 1;
    this.perEngine.set(engine, (this.perEngine.get(engine) ?? 0) + 1);

    if ((this.#options.failingEngines ?? []).includes(engine)) {
      throw new Error(`${engine} is unavailable`);
    }

    const kind =
      this.#options.script?.({ engine, prompt: request.user, call }) ??
      this.#options.fallback ??
      "mentioned-and-cited";
    const text = SCRIPTED_ANSWERS[kind];

    return {
      text,
      usage: {
        inputTokens: Math.ceil(request.user.length / 4),
        outputTokens: Math.ceil(text.length / 4),
        cachedInputTokens: 0,
      },
      // Perplexity-style structured citations, which the parser prefers over scraped URLs.
      citations: kind === "mentioned-and-cited" ? ["https://acme.com/pricing"] : [],
    };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    return this.#inner.embed(request);
  }
}
