/**
 * AccessProber over the guarded HTTP stack: robots.txt plus the per-bot probes and
 * llms.txt. Keeps the fetch details out of the use case, which only judges evidence.
 */
import type { AccessEvidence, AccessProber } from "../../application/ports/access-prober.port.js";
import { fetchRobots } from "./sitemap.js";
import { gatherAccessEvidence } from "./access-prober.js";
import type { DnsResolver, Transport } from "./ssrf-guard.js";

export interface HttpAccessProberOptions {
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly resolver?: DnsResolver;
  readonly transport?: Transport;
}

export class HttpAccessProber implements AccessProber {
  readonly #options: HttpAccessProberOptions;

  constructor(options: HttpAccessProberOptions) {
    this.#options = options;
  }

  async gather(siteOrigin: string): Promise<AccessEvidence> {
    const shared = {
      siteOrigin,
      siteHost: new URL(siteOrigin).hostname,
      userAgent: this.#options.userAgent,
      timeoutMs: this.#options.timeoutMs,
      maxUrls: 0,
      ...(this.#options.resolver === undefined ? {} : { resolver: this.#options.resolver }),
      ...(this.#options.transport === undefined ? {} : { transport: this.#options.transport }),
    };

    const robots = await fetchRobots(shared);
    const { probes, llmsTxtContent } = await gatherAccessEvidence({
      siteOrigin,
      userAgent: this.#options.userAgent,
      timeoutMs: this.#options.timeoutMs,
      ...(this.#options.resolver === undefined ? {} : { resolver: this.#options.resolver }),
      ...(this.#options.transport === undefined ? {} : { transport: this.#options.transport }),
    });

    return { robots, probes, llmsTxtContent };
  }
}
