import { describe, expect, it } from "vitest";
import {
  isPubliclyRoutableHostname,
  normalizePageUrl,
  normalizeSiteUrl,
  urlHash,
} from "../../../../src/domain/crawl/url.js";

const site = (input: string): string => {
  const result = normalizeSiteUrl(input);
  if (!result.ok) throw new Error(`expected ${input} to normalize, got ${result.reason}`);
  return result.value.href;
};

const page = (input: string, base?: string): string => {
  const result = normalizePageUrl(input, base);
  if (!result.ok) throw new Error(`expected ${input} to normalize, got ${result.reason}`);
  return result.value.href;
};

describe("normalizeSiteUrl", () => {
  it.each([
    ["acme.com", "https://acme.com"],
    ["ACME.com", "https://acme.com"],
    ["https://acme.com", "https://acme.com"],
    ["https://acme.com/", "https://acme.com"],
    ["https://www.acme.com", "https://acme.com"],
    ["https://WWW.Acme.COM/", "https://acme.com"],
    ["http://acme.com", "http://acme.com"],
    ["https://acme.com:443", "https://acme.com"],
    ["https://acme.com/pricing?utm=x#top", "https://acme.com"],
    ["  https://acme.com  ", "https://acme.com"],
    ["https://blog.acme.com", "https://blog.acme.com"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(site(input)).toBe(expected);
  });

  it("treats a bare domain and its www/trailing-slash variants as one site", () => {
    const variants = ["acme.com", "www.acme.com", "https://acme.com/", "HTTPS://WWW.ACME.COM"];
    const normalized = new Set(variants.map(site));
    expect(normalized.size).toBe(1);
  });

  it.each([
    ["", "malformed"],
    ["   ", "malformed"],
    ["https://", "malformed"],
    ["ftp://acme.com", "unsupported_scheme"],
    ["javascript:alert(1)", "unsupported_scheme"],
    ["file:///etc/passwd", "unsupported_scheme"],
    ["https://acme.com:8080", "unsupported_port"],
    ["https://localhost", "non_public_host"],
    ["http://127.0.0.1", "non_public_host"],
    ["http://10.0.0.5", "non_public_host"],
    ["http://172.16.4.1", "non_public_host"],
    ["http://192.168.1.1", "non_public_host"],
    ["http://169.254.169.254", "non_public_host"],
    ["http://0.0.0.0", "non_public_host"],
    ["http://[::1]", "non_public_host"],
    ["http://intranet", "non_public_host"],
    ["http://printer.local", "non_public_host"],
  ])("rejects %s as %s", (input, reason) => {
    const result = normalizeSiteUrl(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  });
});

describe("normalizePageUrl", () => {
  it.each([
    ["https://acme.com/pricing", "https://acme.com/pricing"],
    ["https://acme.com/pricing/", "https://acme.com/pricing"],
    ["https://acme.com/pricing#faq", "https://acme.com/pricing"],
    ["https://acme.com/", "https://acme.com/"],
    ["https://www.acme.com/blog/post", "https://acme.com/blog/post"],
    ["https://acme.com/a?b=2&a=1", "https://acme.com/a?a=1&b=2"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(page(input)).toBe(expected);
  });

  it("resolves relative links against the page they were found on", () => {
    expect(page("/pricing", "https://acme.com/blog/post")).toBe("https://acme.com/pricing");
    expect(page("../about", "https://acme.com/blog/post")).toBe("https://acme.com/about");
    expect(page("deeper", "https://acme.com/blog/")).toBe("https://acme.com/blog/deeper");
  });

  it("gives query-order variants a single identity", () => {
    expect(page("https://acme.com/a?b=2&a=1")).toBe(page("https://acme.com/a?a=1&b=2"));
  });

  it("keeps genuinely different pages distinct", () => {
    expect(page("https://acme.com/a")).not.toBe(page("https://acme.com/b"));
    expect(page("https://acme.com/a?page=1")).not.toBe(page("https://acme.com/a?page=2"));
  });

  it("rejects a relative link that escapes into a blocked host", () => {
    const result = normalizePageUrl("//169.254.169.254/latest/meta-data", "https://acme.com/");
    expect(result.ok).toBe(false);
  });
});

describe("urlHash", () => {
  it("is a stable 64-character hex digest", () => {
    const hash = urlHash("https://acme.com/pricing");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(urlHash("https://acme.com/pricing")).toBe(hash);
  });

  it("separates different URLs", () => {
    expect(urlHash("https://acme.com/a")).not.toBe(urlHash("https://acme.com/b"));
  });

  it("collapses variants that normalize to the same page", () => {
    expect(urlHash(page("https://www.acme.com/pricing/"))).toBe(
      urlHash(page("https://acme.com/pricing")),
    );
  });
});

describe("isPubliclyRoutableHostname", () => {
  it.each(["acme.com", "blog.acme.com", "xn--80ak6aa92e.com", "a.co"])(
    "accepts %s",
    (hostname) => {
      expect(isPubliclyRoutableHostname(hostname)).toBe(true);
    },
  );

  it.each([
    "localhost",
    "127.0.0.1",
    "127.1.1.1",
    "10.255.255.255",
    "172.31.0.1",
    "192.168.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "db.internal",
    "my-machine",
    "",
  ])("rejects %s", (hostname) => {
    expect(isPubliclyRoutableHostname(hostname)).toBe(false);
  });

  it("accepts public addresses adjacent to blocked ranges", () => {
    expect(isPubliclyRoutableHostname("11.0.0.1")).toBe(true);
    expect(isPubliclyRoutableHostname("172.32.0.1")).toBe(true);
    expect(isPubliclyRoutableHostname("192.169.0.1")).toBe(true);
  });
});
