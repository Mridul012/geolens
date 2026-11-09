/**
 * How one page's HTML is obtained.
 *
 * Two implementations share the crawler's orchestration: a guarded HTTP fetch (fast, and
 * what robots.txt, sitemaps and the CDN probe need) and a headless browser (slow, and what
 * JS-rendered sites need — docs/Architecture.md Stage 1). Both go through the SSRF guard;
 * neither is allowed to reach the network any other way.
 */
import type { FetchedPage } from "../../application/ports/crawler-engine.port.js";
import { safeFetch, SsrfBlockedError, type DnsResolver, type Transport } from "./ssrf-guard.js";

export interface PageFetcher {
  fetch(url: string): Promise<FetchedPage>;
  /** Releases anything expensive (a browser, a pool). Safe to call twice. */
  close(): Promise<void>;
}

export class PageFetchError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "PageFetchError";
    this.status = status;
  }
}

export interface HttpPageFetcherOptions {
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly maxBytes?: number;
  readonly resolver?: DnsResolver;
  /** Test seam, threaded to the guard; defaults to a real pinned socket. */
  readonly transport?: Transport;
}

/**
 * Plain HTTP through the SSRF guard. No JavaScript is executed, which is exactly right for
 * robots.txt, sitemaps and bot-probing, and adequate for server-rendered pages.
 */
export class HttpPageFetcher implements PageFetcher {
  readonly #options: HttpPageFetcherOptions;

  constructor(options: HttpPageFetcherOptions) {
    this.#options = options;
  }

  async fetch(url: string): Promise<FetchedPage> {
    try {
      const response = await safeFetch(url, {
        method: "GET",
        headers: { "user-agent": this.#options.userAgent, accept: "text/html,*/*;q=0.8" },
        timeoutMs: this.#options.timeoutMs,
        ...(this.#options.maxBytes === undefined ? {} : { maxBytes: this.#options.maxBytes }),
        ...(this.#options.resolver === undefined ? {} : { resolver: this.#options.resolver }),
        ...(this.#options.transport === undefined ? {} : { transport: this.#options.transport }),
      });

      if (response.status >= 400) {
        throw new PageFetchError(`HTTP ${response.status}`, response.status);
      }

      return {
        url: response.finalUrl,
        status: response.status,
        html: response.body.toString("utf8"),
        fetchedAt: new Date(),
        redirectChain: response.redirectChain,
      };
    } catch (error) {
      if (error instanceof PageFetchError) throw error;
      if (error instanceof SsrfBlockedError) {
        throw new PageFetchError(`blocked: ${error.reason}`, null);
      }
      throw new PageFetchError((error as Error).message, null);
    }
  }

  async close(): Promise<void> {
    // Nothing to release: each request owns its socket.
  }
}
