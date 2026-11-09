/**
 * OpenAI adapter — completions, embeddings, and the OpenAI prompt-simulation engine.
 *
 * Provider SDKs are importable only inside this folder (golden rule #1, lint-enforced).
 */
import OpenAI from "openai";
import type {
  CompletionRequest,
  CompletionResult,
  EmbeddingRequest,
  EmbeddingResult,
  ProviderAdapter,
} from "./provider.js";
import { ProviderError } from "./provider.js";

/** Statuses worth another attempt: throttling and transient server faults. */
function isRetryableStatus(status: number | undefined): boolean {
  return status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500);
}

function toProviderError(provider: string, error: unknown): ProviderError {
  const status = (error as { status?: number }).status;
  const message = (error as { message?: string }).message ?? "request failed";
  return new ProviderError(provider, message, {
    retryable: isRetryableStatus(status),
    ...(status === undefined ? {} : { status }),
    cause: error,
  });
}

export interface OpenAiAdapterOptions {
  readonly apiKey: string;
  /** Overridden for OpenAI-compatible providers such as Groq and Perplexity. */
  readonly baseURL?: string;
  readonly name?: string;
}

export class OpenAiAdapter implements ProviderAdapter {
  readonly name: string;
  readonly #client: OpenAI;

  constructor(options: OpenAiAdapterOptions) {
    this.name = options.name ?? "openai";
    this.#client = new OpenAI({
      apiKey: options.apiKey,
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      // Retries are the gateway's decision, not the SDK's — it owns the budget and the
      // ledger, and a silent SDK retry would bill twice without a second ledger row.
      maxRetries: 0,
    });
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    try {
      const response = await this.#client.chat.completions.create(
        {
          model: request.model,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
          temperature: request.temperature,
          max_tokens: request.maxOutputTokens,
          ...(request.jsonMode ? { response_format: { type: "json_object" as const } } : {}),
        },
        { timeout: request.timeoutMs },
      );

      const choice = response.choices[0];
      const text = choice?.message.content ?? "";
      const usage = response.usage;

      // Web-search models return their sources as annotations.
      const annotations = (choice?.message as { annotations?: Array<{ url_citation?: { url?: string } }> })
        ?.annotations;
      const citations = (annotations ?? []).flatMap((annotation) =>
        typeof annotation.url_citation?.url === "string" ? [annotation.url_citation.url] : [],
      );

      return {
        text,
        usage: {
          inputTokens: usage?.prompt_tokens ?? 0,
          outputTokens: usage?.completion_tokens ?? 0,
          cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
        },
        citations,
      };
    } catch (error) {
      throw toProviderError(this.name, error);
    }
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    try {
      const response = await this.#client.embeddings.create(
        { model: request.model, input: [...request.inputs] },
        { timeout: request.timeoutMs },
      );
      return {
        // The API may return results out of order; `index` is authoritative.
        vectors: [...response.data]
          .sort((a, b) => a.index - b.index)
          .map((item) => item.embedding),
        inputTokens: response.usage?.prompt_tokens ?? 0,
      };
    } catch (error) {
      throw toProviderError(this.name, error);
    }
  }
}

/** Groq speaks the OpenAI API, so it needs no adapter of its own — only a base URL. */
export function createGroqAdapter(apiKey: string): OpenAiAdapter {
  return new OpenAiAdapter({
    apiKey,
    baseURL: "https://api.groq.com/openai/v1",
    name: "groq",
  });
}

/**
 * Perplexity is also OpenAI-compatible, and returns its sources in a top-level `citations`
 * array rather than as message annotations.
 */
export class PerplexityAdapter implements ProviderAdapter {
  readonly name = "perplexity";
  readonly #client: OpenAI;

  constructor(apiKey: string) {
    this.#client = new OpenAI({
      apiKey,
      baseURL: "https://api.perplexity.ai",
      maxRetries: 0,
    });
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    try {
      const response = (await this.#client.chat.completions.create(
        {
          model: request.model,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
          temperature: request.temperature,
          max_tokens: request.maxOutputTokens,
        },
        { timeout: request.timeoutMs },
      )) as OpenAI.Chat.Completions.ChatCompletion & { citations?: string[] };

      return {
        text: response.choices[0]?.message.content ?? "",
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
          cachedInputTokens: 0,
        },
        citations: response.citations ?? [],
      };
    } catch (error) {
      throw toProviderError(this.name, error);
    }
  }

  async embed(): Promise<EmbeddingResult> {
    throw new ProviderError(this.name, "does not provide embeddings");
  }
}
