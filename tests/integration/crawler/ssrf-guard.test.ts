/**
 * The SSRF matrix — merge-blocking (Engineering-Rules §9). It may never be skipped or
 * weakened, and touching the guard means re-running all of it (§15.11).
 *
 * The DNS resolver and the socket are injected; the *policy* under test is entirely real.
 * A public-looking host that redirects to cloud metadata cannot be staged any other way.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  resolveAndVerify,
  safeFetch,
  SsrfBlockedError,
  socketTransport,
  type DnsResolver,
  type Transport,
} from "../../../src/infrastructure/crawler/ssrf-guard.js";

/** Resolver that answers every name with the given addresses. */
const resolverFor = (...addresses: string[]): DnsResolver =>
  async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

const publicResolver = resolverFor("93.184.216.34");

/** Transport that replays a scripted response per URL. */
function scriptedTransport(script: Record<string, { status: number; location?: string }>): {
  transport: Transport;
  connectedTo: string[];
} {
  const connectedTo: string[] = [];
  const transport: Transport = async (url, pinned) => {
    connectedTo.push(`${url.href} -> ${pinned.address}`);
    const entry = script[url.href] ?? { status: 200 };
    return {
      status: entry.status,
      headers: entry.location === undefined ? {} : { location: entry.location },
      body: Buffer.from("ok"),
    };
  };
  return { transport, connectedTo };
}

describe("resolveAndVerify", () => {
  it("accepts a name that resolves only to public addresses", async () => {
    const resolved = await resolveAndVerify("acme.com", publicResolver);
    expect(resolved.address).toBe("93.184.216.34");
    expect(resolved.family).toBe(4);
  });

  it("accepts a public literal without touching DNS", async () => {
    let called = false;
    const resolved = await resolveAndVerify("93.184.216.34", async () => {
      called = true;
      return [];
    });
    expect(resolved.address).toBe("93.184.216.34");
    expect(called).toBe(false);
  });

  it.each([
    ["127.0.0.1", "loopback"],
    ["10.0.0.5", "RFC 1918"],
    ["172.16.0.1", "RFC 1918"],
    ["192.168.1.1", "RFC 1918"],
    ["169.254.169.254", "cloud metadata"],
    ["::1", "IPv6 loopback"],
    ["fd00::1", "unique local"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
  ])("rejects a name resolving to %s (%s)", async (address) => {
    await expect(resolveAndVerify("evil.com", resolverFor(address))).rejects.toMatchObject({
      name: "SsrfBlockedError",
      reason: "private_address",
    });
  });

  it("rejects when ANY answer is private, even alongside public ones", async () => {
    await expect(
      resolveAndVerify("mixed.com", resolverFor("93.184.216.34", "10.0.0.5")),
    ).rejects.toMatchObject({ reason: "private_address" });
  });

  it("rejects an empty answer and a failing resolver", async () => {
    await expect(resolveAndVerify("nx.com", async () => [])).rejects.toMatchObject({
      reason: "dns_failure",
    });
    await expect(
      resolveAndVerify("nx.com", async () => {
        throw new Error("NXDOMAIN");
      }),
    ).rejects.toMatchObject({ reason: "dns_failure" });
  });
});

describe("safeFetch — scheme and port policy", () => {
  it.each([
    ["ftp://acme.com/x", "unsupported_scheme"],
    ["file:///etc/passwd", "unsupported_scheme"],
    ["gopher://acme.com/", "unsupported_scheme"],
    ["https://acme.com:8080/x", "unsupported_port"],
    ["https://acme.com:22/x", "unsupported_port"],
  ])("rejects %s as %s", async (url, reason) => {
    await expect(safeFetch(url, { resolver: publicResolver })).rejects.toMatchObject({ reason });
  });

  it.each([
    "http://localhost/x",
    "http://127.0.0.1/x",
    "http://10.0.0.1/x",
    "http://169.254.169.254/latest/meta-data/",
    "http://192.168.0.1/",
    "http://[::1]/",
    "http://metadata.google.internal/",
  ])("rejects %s before any DNS or socket work", async (url) => {
    let resolverCalled = false;
    await expect(
      safeFetch(url, {
        resolver: async () => {
          resolverCalled = true;
          return [];
        },
      }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(resolverCalled).toBe(false);
  });
});

describe("safeFetch — redirect re-validation", () => {
  it("rejects a public URL that redirects to cloud metadata", async () => {
    const { transport, connectedTo } = scriptedTransport({
      "https://acme.com/start": { status: 302, location: "http://169.254.169.254/latest/meta-data/" },
    });

    await expect(
      safeFetch("https://acme.com/start", { resolver: publicResolver, transport }),
    ).rejects.toMatchObject({ reason: "non_public_host" });

    // The first hop connected; the second never did.
    expect(connectedTo).toHaveLength(1);
  });

  it.each([
    "http://127.0.0.1:9200/",
    "http://10.1.2.3/admin",
    "http://[fd00::1]/",
    "http://localhost/",
  ])("rejects a redirect to %s", async (target) => {
    const { transport } = scriptedTransport({
      "https://acme.com/start": { status: 302, location: target },
    });
    await expect(
      safeFetch("https://acme.com/start", { resolver: publicResolver, transport }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects a redirect whose public hostname resolves privately", async () => {
    const { transport } = scriptedTransport({
      "https://acme.com/start": { status: 302, location: "https://rebind.com/next" },
    });
    const resolver: DnsResolver = async (hostname) =>
      hostname === "acme.com"
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "169.254.169.254", family: 4 }];

    await expect(
      safeFetch("https://acme.com/start", { resolver, transport }),
    ).rejects.toMatchObject({ reason: "private_address" });
  });

  it("follows a legitimate public redirect chain and reports every hop", async () => {
    const { transport } = scriptedTransport({
      "https://acme.com/start": { status: 301, location: "https://acme.com/middle" },
      "https://acme.com/middle": { status: 302, location: "https://www.acme.com/end" },
      "https://acme.com/end": { status: 200 },
    });

    const result = await safeFetch("https://acme.com/start", {
      resolver: publicResolver,
      transport,
    });

    expect(result.status).toBe(200);
    // `www.` is dropped by normalization, so the final URL is the canonical one.
    expect(result.finalUrl).toBe("https://acme.com/end");
    expect(result.redirectChain).toEqual([
      "https://acme.com/start",
      "https://acme.com/middle",
      "https://acme.com/end",
    ]);
  });

  it("gives up after the hop limit rather than looping forever", async () => {
    const { transport } = scriptedTransport({
      "https://acme.com/loop": { status: 302, location: "https://acme.com/loop" },
    });

    await expect(
      safeFetch("https://acme.com/loop", {
        resolver: publicResolver,
        transport,
        maxRedirects: 3,
      }),
    ).rejects.toMatchObject({ reason: "too_many_redirects" });
  });

  it("returns the redirect itself when Location is missing", async () => {
    const { transport } = scriptedTransport({ "https://acme.com/x": { status: 302 } });
    const result = await safeFetch("https://acme.com/x", {
      resolver: publicResolver,
      transport,
    });
    expect(result.status).toBe(302);
  });
});

describe("safeFetch — DNS rebinding", () => {
  it("connects to the address it validated, not to a later DNS answer", async () => {
    let call = 0;
    // First answer is public (passes the check); a second lookup would hand back metadata.
    const rebinding: DnsResolver = async () => {
      call += 1;
      return call === 1
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "169.254.169.254", family: 4 }];
    };

    const { transport, connectedTo } = scriptedTransport({ "https://rebind.com/": { status: 200 } });
    await safeFetch("https://rebind.com/", { resolver: rebinding, transport });

    // The socket was pinned to the verified address — the second answer never reached it.
    expect(connectedTo).toEqual(["https://rebind.com/ -> 93.184.216.34"]);
  });
});

describe("safeFetch — real socket", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/big") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("x".repeat(50_000));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>fixture</body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("refuses to reach a loopback fixture server — the guard is not bypassable in practice", async () => {
    await expect(safeFetch(`http://127.0.0.1:${port}/`)).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("connects to the pinned address even though the URL names another host", async () => {
    // The real socket path: the URL says acme.com, the pin says loopback. If pinning were
    // cosmetic this would try to reach the actual acme.com and fail.
    const response = await socketTransport(
      new URL(`http://acme.com:${port}/`),
      { hostname: "acme.com", address: "127.0.0.1", family: 4 },
      { method: "GET", headers: {}, timeoutMs: 5_000, maxBytes: 1_000_000 },
    );

    expect(response.status).toBe(200);
    expect(response.body.toString()).toContain("fixture");
    expect(response.headers["content-type"]).toContain("text/html");
  });

  it("caps an oversized body on the real socket", async () => {
    await expect(
      socketTransport(
        new URL(`http://acme.com:${port}/big`),
        { hostname: "acme.com", address: "127.0.0.1", family: 4 },
        { method: "GET", headers: {}, timeoutMs: 5_000, maxBytes: 1_000 },
      ),
    ).rejects.toMatchObject({ reason: "response_too_large" });
  });

});
