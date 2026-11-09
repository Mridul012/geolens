/**
 * The access-check evidence gatherer, behind a port. The use case decides what the
 * evidence means; the adapter knows how to obtain it.
 */
import type { BotProbeResult } from "../../domain/crawl/access-check.js";
import type { RobotsTxt } from "../../domain/crawl/robots.js";

export interface AccessEvidence {
  readonly robots: RobotsTxt;
  readonly probes: readonly BotProbeResult[];
  readonly llmsTxtContent: string | null;
}

export interface AccessProber {
  gather(siteOrigin: string): Promise<AccessEvidence>;
}
