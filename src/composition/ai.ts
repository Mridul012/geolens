/**
 * AI composition: the gateway, its adapters, budget guard and tracer.
 *
 * The only place a provider adapter is constructed. `AI_PROVIDER_MODE=fake` wires the
 * deterministic adapter for every provider, which is how the whole pipeline runs locally
 * and in CI with no keys and no spend — `config/env.ts` refuses that mode in production.
 */
import { tierConfigFor } from "../config/model-tiers.js";
import type { Provider } from "../config/model-tiers.js";
import { env } from "../config/env.js";
import type { AiGateway } from "../application/ports/ai-gateway.port.js";
import { ProviderGateway } from "../infrastructure/ai/gateway.js";
import { BudgetGuard } from "../infrastructure/ai/budgets/budget-guard.js";
import { FakeAdapter } from "../infrastructure/ai/adapters/fake.adapter.js";
import {
  OpenAiAdapter,
  PerplexityAdapter,
  createGroqAdapter,
} from "../infrastructure/ai/adapters/openai.adapter.js";
import { AnthropicAdapter } from "../infrastructure/ai/adapters/anthropic.adapter.js";
import type { ProviderAdapter } from "../infrastructure/ai/adapters/provider.js";
import { createLoggingTracer, type AiTracer } from "../infrastructure/ai/tracing/tracer.js";
import type { AiUsageRepo } from "../infrastructure/db/repositories/ai-usage.repo.js";
import type { Logger } from "../infrastructure/telemetry/logger.js";

export interface AiComposition {
  readonly gateway: AiGateway;
  readonly tracer: AiTracer;
}

/**
 * Builds the adapter set.
 *
 * A provider with no key is simply absent rather than a broken stub: the gateway degrades
 * with a clear "no adapter configured" message, which beats a confusing 401 from upstream.
 */
function buildAdapters(logger: Logger): Partial<Record<Provider, ProviderAdapter>> {
  if (env.AI_PROVIDER_MODE === "fake") {
    const fake = new FakeAdapter();
    logger.info("ai gateway running in fake mode — no provider calls, no spend");
    return { fake, openai: fake, anthropic: fake, groq: fake, gemini: fake, perplexity: fake };
  }

  const adapters: Partial<Record<Provider, ProviderAdapter>> = {};
  if (env.OPENAI_API_KEY !== undefined) {
    adapters.openai = new OpenAiAdapter({ apiKey: env.OPENAI_API_KEY });
  }
  if (env.ANTHROPIC_API_KEY !== undefined) {
    adapters.anthropic = new AnthropicAdapter(env.ANTHROPIC_API_KEY);
  }
  if (env.GROQ_API_KEY !== undefined) {
    adapters.groq = createGroqAdapter(env.GROQ_API_KEY);
  }
  if (env.PERPLEXITY_API_KEY !== undefined) {
    adapters.perplexity = new PerplexityAdapter(env.PERPLEXITY_API_KEY);
  }

  const configured = Object.keys(adapters);
  if (configured.length === 0) {
    logger.warn("ai gateway has no provider keys configured; every AI stage will degrade");
  } else {
    logger.info({ providers: configured }, "ai gateway configured");
  }
  return adapters;
}

export function createAiComposition(usage: AiUsageRepo, logger: Logger): AiComposition {
  const tracer = createLoggingTracer(logger);
  const gateway = new ProviderGateway({
    config: tierConfigFor(env.AI_PROVIDER_MODE),
    adapters: buildAdapters(logger),
    usage,
    budget: new BudgetGuard(usage, {
      perCrawlMicros: BigInt(env.AI_BUDGET_PER_CRAWL_MICROS),
      perRunMicros: BigInt(env.AI_BUDGET_PER_RUN_MICROS),
    }),
    tracer,
  });

  return { gateway, tracer };
}
