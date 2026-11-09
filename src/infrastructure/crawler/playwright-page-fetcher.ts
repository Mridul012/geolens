/**
 * Headless-browser fetching for JS-rendered sites (docs/Architecture.md Stage 1).
 *
 * ── Why the guard is re-applied here ─────────────────────────────────────────
 * A browser resolves and connects on its own, so `safeFetch`'s pinning cannot protect a
 * navigation. Instead every request the page makes — the navigation itself, its redirects,
 * and every subresource — is intercepted and re-checked against the same policy before it
 * is allowed to proceed. A page that tries to pull `http://169.254.169.254/` for its
 * "analytics" is aborted, not fetched.
 *
 * Browser workers additionally run egress-restricted at the network level
 * (docs/Backend.md §14); this is defence in depth, not the only defence.
 */
import { chromium, type Browser, type BrowserContext, type Route } from "playwright";
import type { FetchedPage } from "../../application/ports/crawler-engine.port.js";
import { isPubliclyRoutableHostname } from "../../domain/crawl/url.js";
import { resolveAndVerify, type DnsResolver } from "./ssrf-guard.js";
import { PageFetchError, type PageFetcher } from "./page-fetcher.js";

export interface PlaywrightPageFetcherOptions {
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly resolver?: DnsResolver;
  /** Subresource types worth loading; images and fonts change nothing we measure. */
  readonly blockResourceTypes?: readonly string[];
}

const DEFAULT_BLOCKED_RESOURCES = ["image", "media", "font", "stylesheet"] as const;

export class PlaywrightPageFetcher implements PageFetcher {
  readonly #options: PlaywrightPageFetcherOptions;
  #browser: Browser | null = null;

  constructor(options: PlaywrightPageFetcherOptions) {
    this.#options = options;
  }

  /** One browser per worker process, a fresh context per page (docs/Backend.md §6). */
  async #ensureBrowser(): Promise<Browser> {
    if (this.#browser !== null) return this.#browser;
    this.#browser = await chromium.launch({
      args: ["--disable-dev-shm-usage", "--no-sandbox"],
    });
    return this.#browser;
  }

  async #guardRoute(route: Route): Promise<void> {
    const url = route.request().url();
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        await route.abort("blockedbyclient");
        return;
      }
      const blockedTypes = this.#options.blockResourceTypes ?? DEFAULT_BLOCKED_RESOURCES;
      if (blockedTypes.includes(route.request().resourceType())) {
        await route.abort("blockedbyclient");
        return;
      }
      if (!isPubliclyRoutableHostname(parsed.hostname)) {
        await route.abort("blockedbyclient");
        return;
      }
      // Full DNS verification, same policy as safeFetch. Throws for a private answer.
      await resolveAndVerify(parsed.hostname, this.#options.resolver);
      await route.continue();
    } catch {
      await route.abort("blockedbyclient");
    }
  }

  async fetch(url: string): Promise<FetchedPage> {
    const browser = await this.#ensureBrowser();
    let context: BrowserContext | null = null;

    try {
      context = await browser.newContext({
        userAgent: this.#options.userAgent,
        javaScriptEnabled: true,
        // No storage carries between pages: each page is an independent observation.
        ignoreHTTPSErrors: false,
      });
      await context.route("**/*", (route) => void this.#guardRoute(route));

      const page = await context.newPage();
      page.setDefaultTimeout(this.#options.timeoutMs);

      const redirectChain: string[] = [url];
      page.on("response", (response) => {
        const status = response.status();
        if (status >= 300 && status < 400) redirectChain.push(response.url());
      });

      const response = await page.goto(url, {
        // `domcontentloaded` plus a short settle beats `networkidle`, which never fires on
        // sites with long-polling or analytics heartbeats.
        waitUntil: "domcontentloaded",
        timeout: this.#options.timeoutMs,
      });

      if (response === null) {
        throw new PageFetchError("navigation produced no response", null);
      }
      const status = response.status();
      if (status >= 400) throw new PageFetchError(`HTTP ${status}`, status);

      await page.waitForTimeout(500);
      const html = await page.content();
      const finalUrl = page.url();

      return {
        url: finalUrl,
        status,
        html,
        fetchedAt: new Date(),
        redirectChain: [...redirectChain, finalUrl],
      };
    } catch (error) {
      if (error instanceof PageFetchError) throw error;
      throw new PageFetchError((error as Error).message, null);
    } finally {
      await context?.close();
    }
  }

  async close(): Promise<void> {
    await this.#browser?.close();
    this.#browser = null;
  }
}
