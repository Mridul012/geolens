/**
 * Anthropic adapter — the `frontier` tier: taxonomy, executive summaries, recommendations.
 *
 * Provider SDKs are importable only inside this folder (golden rule #1, lint-enforced).
 */
import Anthropic from "@anthropic-ai/sdk";
import type {
  CompletionRequest,
  CompletionResult,
  EmbeddingResult,
  ProviderAdapter,
} from "./provider.js";
import { ProviderError } from "./provider.js";

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = "anthropic";
  readonly #client: Anthropic;

  constructor(apiKey: string) {
    // Retries belong to the gateway, which owns the budget and the ledger.
    this.#client = new Anthropic({ apiKey, maxRetries: 0 });
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    try {
      const response = await this.#client.messages.create(
        {
          model: request.model,
          max_tokens: request.maxOutputTokens,
          temperature: request.temperature,
          // Cache the system prefix: across a 100-page crawl this is the difference
          // between paying for the rubric once and paying for it a hundred times (§6).
          system: request.cacheSystemPrompt
            ? [
                {
                  type: "text" as const,
                  text: request.system,
                  cache_control: { type: "ephemeral" as const },
                },
              ]
            : request.system,
          messages: [
            {
              role: "user" as const,
              // Anthropic has no JSON mode; prefilling the assistant turn with `{` is the
              // documented way to force a bare JSON object and suppress preamble prose.
              content: request.jsonMode
                ? `${request.user}\n\nRespond with a single JSON object and nothing else.`
                : request.user,
            },
          ],
        },
        { timeout: request.timeoutMs },
      );

      const text = response.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("");

      return {
        text,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
        },
        citations: [],
      };
    } catch (error) {
      const status = (error as { status?: number }).status;
      throw new ProviderError(this.name, (error as Error).message, {
        retryable: status === 429 || (status !== undefined && status >= 500),
        ...(status === undefined ? {} : { status }),
        cause: error,
      });
    }
  }

  async embed(): Promise<EmbeddingResult> {
    throw new ProviderError(this.name, "does not provide embeddings");
  }
}
