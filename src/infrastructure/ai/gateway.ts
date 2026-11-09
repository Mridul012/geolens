/**
 * The AI gateway (docs/Backend.md §7) — the choke point that makes the PRD's cost and risk
 * requirements real.
 *
 * Every model call in the product passes through here and gets, without the caller asking:
 * tier→model resolution, schema validation with exactly one repair retry, a budget
 * pre-check that degrades rather than crashes, an `ai_usage` ledger row, and a trace.
 *
 * The ordering is deliberate. Budget is checked *before* spending. The ledger is written
 * *after* every attempt including failures, because a failed call still costs money. And a
 * repair retry writes its own row, so "how many calls did that crawl make" has an honest
 * answer.
 */
import type {
  AiCallContext,
  AiGateway,
  EmbeddingRequest,
  EmbeddingResponse,
  EngineRequest,
  EngineResponse,
  StructuredRequest,
  StructuredResponse,
} from "../../application/ports/ai-gateway.port.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { degraded } from "../../domain/shared/app-error.js";
import {
  costMicrosFor,
  embeddingCostMicros,
  resolveSpec,
  type ModelSpec,
  type Provider,
  type TierConfig,
} from "../../config/model-tiers.js";
import type { AiUsageRepo } from "../db/repositories/ai-usage.repo.js";
import type { ProviderAdapter } from "./adapters/provider.js";
import { ProviderError } from "./adapters/provider.js";
import type { BudgetGuard } from "./budgets/budget-guard.js";
import { repairPrompt, validateAgainst } from "./structured/parse.js";
import type { AiTracer } from "./tracing/tracer.js";

export interface GatewayOptions {
  readonly config: TierConfig;
  readonly adapters: Readonly<Partial<Record<Provider, ProviderAdapter>>>;
  readonly usage: AiUsageRepo;
  readonly budget: BudgetGuard;
  readonly tracer: AiTracer;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class ProviderGateway implements AiGateway {
  readonly #options: GatewayOptions;

  constructor(options: GatewayOptions) {
    this.#options = options;
  }

  async structured<T>(
    request: StructuredRequest<T>,
  ): Promise<Result<StructuredResponse<T>, AppError>> {
    const spec = resolveSpec(this.#options.config, request.tier);
    const adapter = this.#adapterFor(spec.provider);
    if (adapter === null) {
      return err(degraded(`No adapter configured for provider "${spec.provider}".`));
    }

    const budget = await this.#options.budget.check(request.context);
    if (!budget.allowed) {
      // Degrade, never overspend and never crash the pipeline (§6).
      return err(
        degraded(
          `Budget exhausted for this ${budget.scope}: spent ${budget.spentMicros} of ${budget.limitMicros} micro-USD.`,
        ),
      );
    }

    const trace = this.#options.tracer.startTrace({
      name: request.promptId,
      purpose: request.context.purpose,
      model: spec.model,
      provider: spec.provider,
      ...(request.context.projectId === undefined
        ? {}
        : { projectId: request.context.projectId }),
      ...(request.context.requestId === undefined
        ? {}
        : { requestId: request.context.requestId }),
    });

    let attemptUser = request.userPrompt;
    let lastOutput = "";
    let lastProblem = "";
    let totalCost = 0n;
    const startedAt = Date.now();

    // One attempt, then exactly one repair. Never more (§6).
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let text: string;
      try {
        const completion = await adapter.complete({
          model: spec.model,
          system: request.systemPrompt,
          user: attemptUser,
          temperature: spec.temperature,
          maxOutputTokens: spec.maxOutputTokens,
          jsonMode: spec.supportsStructuredOutput,
          cacheSystemPrompt: spec.supportsPromptCaching,
          timeoutMs: this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
        text = completion.text;

        const cost = costMicrosFor(spec, completion.usage);
        totalCost += cost;
        await this.#meter(request.context, spec, completion.usage, cost, Date.now() - startedAt);
      } catch (error) {
        const providerError =
          error instanceof ProviderError
            ? error
            : new ProviderError(spec.provider, (error as Error).message);
        trace.fail(providerError.message);
        return err(degraded(`${request.promptId} failed: ${providerError.message}`));
      }

      const outcome = validateAgainst(text, request.schema);
      if (outcome.ok) {
        trace.succeed({ repaired: attempt > 0, costUsdMicros: totalCost });
        return ok({
          output: outcome.value,
          model: spec.model,
          promptId: request.promptId,
          repaired: attempt > 0,
          costUsdMicros: totalCost,
          latencyMs: Date.now() - startedAt,
        });
      }

      lastOutput = text;
      lastProblem = outcome.detail;
      attemptUser = repairPrompt(text, outcome.detail);
    }

    // Two attempts, still invalid. A typed failure — never a guessed parse.
    trace.fail(`schema validation failed after repair: ${lastProblem}`);
    return err(
      degraded(
        `${request.promptId} returned output that does not match its schema, twice. Last problem:\n${lastProblem}\nLast output began: ${lastOutput.slice(0, 200)}`,
      ),
    );
  }

  async askEngine(request: EngineRequest): Promise<Result<EngineResponse, AppError>> {
    const spec = resolveSpec(this.#options.config, request.tier as never);
    const adapter = this.#adapterFor(spec.provider);
    if (adapter === null) {
      return err(degraded(`No adapter configured for engine provider "${spec.provider}".`));
    }

    const budget = await this.#options.budget.check(request.context);
    if (!budget.allowed) {
      return err(degraded(`Budget exhausted for this ${budget.scope}.`));
    }

    const trace = this.#options.tracer.startTrace({
      name: request.tier,
      purpose: request.context.purpose,
      model: spec.model,
      provider: spec.provider,
      ...(request.context.projectId === undefined
        ? {}
        : { projectId: request.context.projectId }),
    });

    const startedAt = Date.now();
    try {
      const completion = await adapter.complete({
        model: spec.model,
        // An engine is answering as it would for a user; no system framing of our own.
        system: "",
        user: request.prompt,
        temperature: spec.temperature,
        maxOutputTokens: spec.maxOutputTokens,
        jsonMode: false,
        cacheSystemPrompt: false,
        timeoutMs: this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });

      const cost = costMicrosFor(spec, completion.usage);
      const latencyMs = Date.now() - startedAt;
      await this.#meter(request.context, spec, completion.usage, cost, latencyMs);
      trace.succeed({ repaired: false, costUsdMicros: cost });

      return ok({
        answerText: completion.text,
        citations: completion.citations,
        model: spec.model,
        costUsdMicros: cost,
        latencyMs,
      });
    } catch (error) {
      const message = (error as Error).message;
      trace.fail(message);
      // An engine is never failed over to another provider — that would change what we
      // measured (AI-Pipeline §1). The cell is recorded as an error instead.
      return err(degraded(`Engine ${request.tier} did not answer: ${message}`));
    }
  }

  async embed(request: EmbeddingRequest): Promise<Result<EmbeddingResponse, AppError>> {
    const spec = this.#options.config.embedding;
    const adapter = this.#adapterFor(spec.provider);
    if (adapter === null) {
      return err(degraded(`No adapter configured for provider "${spec.provider}".`));
    }
    if (request.inputs.length === 0) {
      return ok({ vectors: [], model: spec.model, dimensions: spec.dimensions, costUsdMicros: 0n });
    }

    const budget = await this.#options.budget.check(request.context);
    if (!budget.allowed) {
      return err(degraded(`Budget exhausted for this ${budget.scope}.`));
    }

    const startedAt = Date.now();
    const vectors: Array<readonly number[]> = [];
    let totalCost = 0n;
    let totalTokens = 0;

    try {
      // Batched to the provider's cap: embeddings are the one call the pipeline makes
      // thousands of, so per-request overhead is worth eliminating (§13).
      for (let index = 0; index < request.inputs.length; index += spec.maxBatchSize) {
        const batch = request.inputs.slice(index, index + spec.maxBatchSize);
        const result = await adapter.embed({
          model: spec.model,
          inputs: batch,
          timeoutMs: this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });

        if (result.vectors.length !== batch.length) {
          return err(
            degraded(
              `Embedding provider returned ${result.vectors.length} vectors for ${batch.length} inputs.`,
            ),
          );
        }
        vectors.push(...result.vectors);
        totalTokens += result.inputTokens;
        totalCost += embeddingCostMicros(spec, result.inputTokens);
      }
    } catch (error) {
      return err(degraded(`Embedding failed: ${(error as Error).message}`));
    }

    await this.#meter(
      request.context,
      { provider: spec.provider, model: spec.model },
      { inputTokens: totalTokens, outputTokens: 0, cachedInputTokens: 0 },
      totalCost,
      Date.now() - startedAt,
    );

    return ok({
      vectors,
      model: spec.model,
      dimensions: spec.dimensions,
      costUsdMicros: totalCost,
    });
  }

  #adapterFor(provider: Provider): ProviderAdapter | null {
    return this.#options.adapters[provider] ?? null;
  }

  /**
   * Writes the ledger row and updates the in-memory budget.
   *
   * A metering failure must never fail the call that succeeded — the answer is already
   * paid for, and losing it to a bookkeeping error helps nobody. It is logged by the
   * caller's tracer instead.
   */
  async #meter(
    context: AiCallContext,
    spec: Pick<ModelSpec, "provider" | "model">,
    usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number },
    costMicros: bigint,
    latencyMs: number,
  ): Promise<void> {
    this.#options.budget.addSpend(context, costMicros);
    try {
      await this.#options.usage.record({
        projectId: context.projectId ?? null,
        crawlId: context.crawlId ?? null,
        promptRunId: context.promptRunId ?? null,
        purpose: context.purpose,
        provider: spec.provider,
        model: spec.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        costUsdMicros: costMicros,
        latencyMs,
      });
    } catch (error) {
      this.#options.tracer.warn(`ai_usage write failed: ${(error as Error).message}`);
    }
  }
}
