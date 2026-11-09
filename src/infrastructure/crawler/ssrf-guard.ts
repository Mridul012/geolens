/**
 * The SSRF guard — threat #1 for this product (Engineering-Rules §12, docs/Backend.md §14).
 *
 * Every fetch of a user-influenced URL goes through here: the crawler, the CDN probe,
 * robots.txt and llms.txt. Four properties, all mandatory:
 *
 * 1. **Scheme and port allowlist** — http/https on 80/443 only.
 * 2. **Resolve before connect** — DNS is performed by us, and *every* returned address must
 *    be publicly routable. One private answer rejects the whole name.
 * 3. **Pin the resolved IP** — the socket connects to the address we validated, not to
 *    whatever a second DNS lookup returns. This is what defeats DNS rebinding, where a
 *    name answers public on the check and private on the connect.
 * 4. **Re-validate every redirect hop** — a public URL that 302s to 169.254.169.254 is the
 *    oldest trick in the book.
 *
 * Touching this file requires re-running the full SSRF matrix (§15.11).
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { isPubliclyRoutableIp } from "../../domain/crawl/ip-policy.js";
import { normalizePageUrl } from "../../domain/crawl/url.js";

export type SsrfRejectionReason =
  | "malformed_url"
  | "unsupported_scheme"
  | "unsupported_port"
  | "non_public_host"
  | "dns_failure"
  | "private_address"
  | "too_many_redirects"
  | "response_too_large"
  | "timeout"
  | "network_error";

export class SsrfBlockedError extends Error {
  readonly reason: SsrfRejectionReason;
  readonly url: string;

  constructor(reason: SsrfRejectionReason, url: string, detail?: string) {
    super(`Blocked request to ${url}: ${reason}${detail === undefined ? "" : ` (${detail})`}`);
    this.name = "SsrfBlockedError";
    this.reason = reason;
    this.url = url;
  }
}

export interface ResolvedHost {
  readonly hostname: string;
  /** The single address the socket is pinned to. */
  readonly address: string;
  readonly family: 4 | 6;
}

export type DnsResolver = (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;

const defaultResolver: DnsResolver = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => ({ address: entry.address, family: entry.family }));
};

/**
 * Resolves a hostname and verifies every answer.
 *
 * Rejecting on *any* private answer — rather than filtering to the public ones — is
 * deliberate: a name that resolves to both is either misconfigured or hostile, and neither
 * deserves a connection.
 */
export async function resolveAndVerify(
  hostname: string,
  resolver: DnsResolver = defaultResolver,
): Promise<ResolvedHost> {
  // A literal address needs no DNS, but still needs the policy.
  const literal = hostname.replace(/^\[|\]$/g, "");
  if (isPubliclyRoutableIp(literal)) {
    return { hostname, address: literal, family: literal.includes(":") ? 6 : 4 };
  }

  let answers: ReadonlyArray<{ address: string; family: number }>;
  try {
    answers = await resolver(hostname);
  } catch (error) {
    throw new SsrfBlockedError("dns_failure", hostname, (error as Error).message);
  }

  if (answers.length === 0) throw new SsrfBlockedError("dns_failure", hostname, "no addresses");

  for (const answer of answers) {
    if (!isPubliclyRoutableIp(answer.address)) {
      throw new SsrfBlockedError("private_address", hostname, answer.address);
    }
  }

  const first = answers[0] as { address: string; family: number };
  return { hostname, address: first.address, family: first.family === 6 ? 6 : 4 };
}

export interface SafeFetchOptions {
  readonly method?: "GET" | "HEAD";
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly resolver?: DnsResolver;
  /** Test seam; defaults to a real pinned socket. */
  readonly transport?: Transport;
}

export interface SafeFetchResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
  /** The URL that actually served the response, after any redirects. */
  readonly finalUrl: string;
  /** Every hop, in order — evidence for the access check's CDN-block detection. */
  readonly redirectChain: readonly string[];
}

const DEFAULTS = {
  timeoutMs: 15_000,
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 5,
} as const;

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export interface TransportOptions {
  readonly method: "GET" | "HEAD";
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

export interface TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
}

/**
 * One hop over the wire. Injectable so the SSRF matrix can exercise the *policy* — redirect
 * re-validation, rebinding, hop limits — without needing a real public host to redirect
 * from. The policy is never faked; only the socket is.
 */
export type Transport = (
  url: URL,
  pinned: ResolvedHost,
  options: TransportOptions,
) => Promise<TransportResponse>;

/**
 * Performs one hop against an already-verified, pinned address.
 *
 * Exported so the matrix can prove the pinning is real: given a URL naming one host and a
 * pinned address pointing elsewhere, the connection must follow the pin.
 */
export const socketTransport: Transport = async (
  url: URL,
  pinned: ResolvedHost,
  options: TransportOptions,
): Promise<TransportResponse> => {
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;

  // The socket connects to the address we validated. A second DNS answer cannot smuggle
  // in a different destination between check and connect.
  //
  // Node calls `lookup` with `all: true` in some paths and expects an array back; with
  // `all: false` it expects (address, family). Answering the wrong shape surfaces as
  // "Invalid IP address: undefined", so both are handled explicitly.
  const lookup: LookupFunction = (_hostname, opts, callback) => {
    const all = typeof opts === "object" && opts !== null && opts.all === true;
    if (all) {
      (callback as unknown as (
        err: Error | null,
        addresses: Array<{ address: string; family: number }>,
      ) => void)(null, [{ address: pinned.address, family: pinned.family }]);
      return;
    }
    (callback as (err: Error | null, address: string, family: number) => void)(
      null,
      pinned.address,
      pinned.family,
    );
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      action();
    };

    const request = send(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: options.method,
        headers: { host: url.host, ...options.headers },
        timeout: options.timeoutMs,
        lookup,
        // Redirects are followed by the caller so every hop is re-validated.
        setHost: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > options.maxBytes) {
            // Reject before destroying: tearing the socket down raises its own error, and
            // the caller deserves the real reason rather than "socket hang up".
            settle(() =>
              reject(new SsrfBlockedError("response_too_large", url.href, `${total} bytes`)),
            );
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          settle(() =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks),
            }),
          );
        });
        response.on("error", (error) =>
          settle(() => reject(new SsrfBlockedError("network_error", url.href, error.message))),
        );
      },
    );

    request.on("timeout", () => {
      settle(() => reject(new SsrfBlockedError("timeout", url.href)));
      request.destroy();
    });
    request.on("error", (error) => {
      settle(() =>
        reject(
          error instanceof SsrfBlockedError
            ? error
            : new SsrfBlockedError("network_error", url.href, error.message),
        ),
      );
    });
    request.end();
  });
};

/**
 * Fetches a user-influenced URL safely.
 *
 * @throws {SsrfBlockedError} when any hop fails the policy. Callers surface this as a
 * finding, never as a crash — a blocked target is information, not an outage.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
  const maxRedirects = options.maxRedirects ?? DEFAULTS.maxRedirects;
  const resolver = options.resolver ?? defaultResolver;
  const method = options.method ?? "GET";
  const headers = options.headers ?? {};
  const transport = options.transport ?? socketTransport;

  const redirectChain: string[] = [];
  let current = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    // Every hop re-enters the syntactic policy: scheme, port and host are checked again,
    // because a redirect target is just another user-influenced URL.
    const normalized = normalizePageUrl(current);
    if (!normalized.ok) {
      const reason: SsrfRejectionReason =
        normalized.reason === "unsupported_scheme"
          ? "unsupported_scheme"
          : normalized.reason === "unsupported_port"
            ? "unsupported_port"
            : normalized.reason === "non_public_host"
              ? "non_public_host"
              : "malformed_url";
      throw new SsrfBlockedError(reason, current);
    }

    const url = new URL(normalized.value.href);
    const pinned = await resolveAndVerify(url.hostname, resolver);
    redirectChain.push(url.href);

    const response = await transport(url, pinned, { timeoutMs, maxBytes, method, headers });

    if (!isRedirect(response.status)) {
      return {
        status: response.status,
        headers: response.headers,
        body: response.body,
        finalUrl: url.href,
        redirectChain,
      };
    }

    const location = response.headers.location;
    if (typeof location !== "string" || location.length === 0) {
      return {
        status: response.status,
        headers: response.headers,
        body: response.body,
        finalUrl: url.href,
        redirectChain,
      };
    }
    current = new URL(location, url).href;
  }

  throw new SsrfBlockedError("too_many_redirects", rawUrl, `over ${maxRedirects} hops`);
}
