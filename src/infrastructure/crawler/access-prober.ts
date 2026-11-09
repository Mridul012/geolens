/**
 * Gathers the evidence the access check judges (PRD FR-4.3).
 *
 * Every request here goes through the SSRF guard — these are user-influenced URLs like any
 * other (Engineering-Rules §12). Everything is best-effort: a probe that fails yields a
 * null status, and the pure evaluator decides what that means. A site refusing us is a
 * *finding*, never a crawl failure.
 */
import type { BotProbeResult } from "../../domain/crawl/access-check.js";
import { AI_BOTS } from "../../domain/crawl/ai-bots.js";
import { safeFetch, type DnsResolver, type Transport } from "./ssrf-guard.js";

export interface AccessProbeOptions {
  readonly siteOrigin: string;
  /** Our own UA, used for the baseline comparison. */
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly resolver?: DnsResolver;
  readonly transport?: Transport;
}

export interface ProbeEvidence {
  readonly probes: readonly BotProbeResult[];
  readonly llmsTxtContent: string | null;
}

/** A browser UA for the baseline: the comparison only means something against a normal client. */
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function statusFor(
  url: string,
  userAgent: string,
  options: AccessProbeOptions,
): Promise<number | null> {
  try {
    const response = await safeFetch(url, {
      // HEAD is enough to learn whether we are welcome, and costs the site far less.
      method: "HEAD",
      headers: { "user-agent": userAgent },
      timeoutMs: options.timeoutMs,
      maxBytes: 64 * 1024,
      ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
      ...(options.transport === undefined ? {} : { transport: options.transport }),
    });
    return response.status;
  } catch {
    return null;
  }
}

async function fetchTextOrNull(
  url: string,
  options: AccessProbeOptions,
): Promise<string | null> {
  try {
    const response = await safeFetch(url, {
      method: "GET",
      headers: { "user-agent": options.userAgent },
      timeoutMs: options.timeoutMs,
      maxBytes: 512 * 1024,
      ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
      ...(options.transport === undefined ? {} : { transport: options.transport }),
    });
    return response.status >= 200 && response.status < 300 ? response.body.toString("utf8") : null;
  } catch {
    return null;
  }
}

/**
 * Probes the homepage once per AI bot and once as a browser, then reads llms.txt.
 *
 * Sequential rather than parallel: firing seven simultaneous requests at a customer's
 * origin is exactly the behaviour the politeness policy exists to prevent, and the whole
 * check costs well under a second either way.
 */
export async function gatherAccessEvidence(
  options: AccessProbeOptions,
): Promise<ProbeEvidence> {
  const homepage = `${options.siteOrigin}/`;
  const baselineStatus = await statusFor(homepage, BROWSER_UA, options);

  const probes: BotProbeResult[] = [];
  for (const bot of AI_BOTS) {
    probes.push({
      botId: bot.id,
      status: await statusFor(homepage, bot.userAgent, options),
      baselineStatus,
    });
  }

  const llmsTxtContent = await fetchTextOrNull(`${options.siteOrigin}/llms.txt`, options);

  return { probes, llmsTxtContent };
}
