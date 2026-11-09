/**
 * A small website, served over real HTTP, for crawl integration tests.
 *
 * The crawler is pointed at `https://acme.com` and the SSRF guard's socket is pinned to
 * this loopback server — so discovery, politeness, robots handling, redirects and
 * extraction all run for real, over real sockets, against real markup. Only the DNS answer
 * is staged, which is the one thing a test cannot legitimately own.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  socketTransport,
  type DnsResolver,
  type Transport,
} from "../../src/infrastructure/crawler/ssrf-guard.js";

export interface FixtureRoute {
  readonly status?: number;
  readonly contentType?: string;
  readonly body: string;
  readonly headers?: Record<string, string>;
  /** Delays the response, for timeout and politeness tests. */
  readonly delayMs?: number;
}

export interface FixtureSite {
  readonly origin: string;
  readonly host: string;
  readonly port: number;
  /** Wire these into any crawler component to reach the fixture. */
  readonly resolver: DnsResolver;
  readonly transport: Transport;
  readonly requests: () => readonly string[];
  readonly requestHeaders: () => ReadonlyArray<{ url: string; userAgent: string | undefined }>;
  readonly close: () => Promise<void>;
}

const HOST = "acme.com";

export async function startFixtureSite(
  routes: Readonly<Record<string, FixtureRoute>>,
): Promise<FixtureSite> {
  const requests: string[] = [];
  const headers: Array<{ url: string; userAgent: string | undefined }> = [];

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    requests.push(path);
    headers.push({ url: path, userAgent: req.headers["user-agent"] });

    const route = routes[path];
    if (route === undefined) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<html><body>Not found</body></html>");
      return;
    }

    const respond = (): void => {
      res.writeHead(route.status ?? 200, {
        "content-type": route.contentType ?? "text/html; charset=utf-8",
        ...(route.headers ?? {}),
      });
      res.end(route.body);
    };

    if (route.delayMs !== undefined && route.delayMs > 0) {
      setTimeout(respond, route.delayMs);
      return;
    }
    respond();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    origin: `https://${HOST}`,
    host: HOST,
    port,
    // The guard verifies this answer as public and pins to it; the transport below then
    // redirects the actual socket to the fixture. The policy is never bypassed — the test
    // simply owns what DNS says.
    resolver: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async (url, _pinned, options) => {
      const local = new URL(url.href);
      local.protocol = "http:";
      local.port = String(port);
      return socketTransport(local, { hostname: HOST, address: "127.0.0.1", family: 4 }, options);
    },
    requests: () => requests,
    requestHeaders: () => headers,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** Convenience: a page with a title, some prose and the given links. */
export function fixturePage(
  title: string,
  links: readonly string[] = [],
  extra = "",
): FixtureRoute {
  return {
    body: `<!doctype html><html lang="en"><head><title>${title}</title>
      <meta name="description" content="${title} description" /></head>
      <body><main><h1>${title}</h1>
      <p>${"Substantive prose about the subject at hand. ".repeat(12)}</p>
      ${links.map((href) => `<a href="${href}">${href}</a>`).join("\n")}
      ${extra}
      </main></body></html>`,
  };
}
