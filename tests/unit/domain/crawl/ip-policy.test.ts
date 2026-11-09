/**
 * Part of the SSRF matrix — a merge-blocking suite (Engineering-Rules §9). It may never be
 * skipped or weakened; touching the guard means re-running all of it.
 */
import { describe, expect, it } from "vitest";
import { isPubliclyRoutableIp, parseIp, parseIpv4, parseIpv6 } from "../../../../src/domain/crawl/ip-policy.js";

describe("parseIpv4", () => {
  it("accepts canonical dotted quads", () => {
    expect(parseIpv4("8.8.8.8")?.parts).toEqual([8, 8, 8, 8]);
    expect(parseIpv4("0.0.0.0")?.parts).toEqual([0, 0, 0, 0]);
    expect(parseIpv4("255.255.255.255")?.parts).toEqual([255, 255, 255, 255]);
  });

  it("rejects zero-padded octets — resolvers disagree on whether they are octal", () => {
    expect(parseIpv4("010.0.0.1")).toBeNull();
    expect(parseIpv4("127.000.000.1")).toBeNull();
  });

  it("rejects out-of-range and malformed forms", () => {
    expect(parseIpv4("256.0.0.1")).toBeNull();
    expect(parseIpv4("1.2.3")).toBeNull();
    expect(parseIpv4("1.2.3.4.5")).toBeNull();
    expect(parseIpv4("acme.com")).toBeNull();
    expect(parseIpv4("")).toBeNull();
  });
});

describe("parseIpv6", () => {
  it("expands :: to eight groups", () => {
    expect(parseIpv6("::1")?.parts).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("::")?.parts).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6("fe80::1")?.parts).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  });

  it("parses a full address and strips brackets", () => {
    expect(parseIpv6("[2001:4860:4860::8888]")?.parts).toEqual([
      0x2001, 0x4860, 0x4860, 0, 0, 0, 0, 0x8888,
    ]);
  });

  it("expands an IPv4-mapped tail into two groups", () => {
    expect(parseIpv6("::ffff:127.0.0.1")?.parts).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001]);
  });

  it("rejects zone identifiers and malformed input", () => {
    expect(parseIpv6("fe80::1%eth0")).toBeNull();
    expect(parseIpv6("1::2::3")).toBeNull();
    expect(parseIpv6("gggg::1")).toBeNull();
    expect(parseIpv6("8.8.8.8")).toBeNull();
  });
});

describe("isPubliclyRoutableIp", () => {
  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "11.0.0.1",
    "172.32.0.1",
    "192.169.0.1",
    "2001:4860:4860::8888",
    "2606:4700:4700::1111",
  ])("allows public address %s", (ip) => {
    expect(isPubliclyRoutableIp(ip)).toBe(true);
  });

  it.each([
    ["0.0.0.0", "this network"],
    ["10.0.0.1", "RFC 1918"],
    ["10.255.255.255", "RFC 1918 upper"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback range"],
    ["169.254.169.254", "cloud metadata"],
    ["169.254.170.2", "ECS task metadata"],
    ["172.16.0.1", "RFC 1918"],
    ["172.31.255.255", "RFC 1918 upper"],
    ["192.168.1.1", "RFC 1918"],
    ["192.0.0.1", "IETF assignments"],
    ["192.0.2.1", "TEST-NET-1"],
    ["198.18.0.1", "benchmarking"],
    ["198.51.100.1", "TEST-NET-2"],
    ["203.0.113.1", "TEST-NET-3"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "broadcast"],
  ])("blocks %s (%s)", (ip) => {
    expect(isPubliclyRoutableIp(ip)).toBe(false);
  });

  it.each([
    ["::1", "IPv6 loopback"],
    ["::", "unspecified"],
    ["fe80::1", "link-local"],
    ["fd00::1", "unique local"],
    ["fc00::1", "unique local"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "documentation"],
    ["64:ff9b::7f00:1", "NAT64 to loopback"],
  ])("blocks IPv6 %s (%s)", (ip) => {
    expect(isPubliclyRoutableIp(ip)).toBe(false);
  });

  it("blocks IPv4-mapped IPv6 that tunnels to a private target", () => {
    expect(isPubliclyRoutableIp("::ffff:127.0.0.1")).toBe(false);
    expect(isPubliclyRoutableIp("::ffff:10.0.0.1")).toBe(false);
    expect(isPubliclyRoutableIp("::ffff:169.254.169.254")).toBe(false);
    // …but a mapped public address is still public.
    expect(isPubliclyRoutableIp("::ffff:8.8.8.8")).toBe(true);
  });

  it("blocks anything it cannot parse — unknown is never allowed", () => {
    expect(isPubliclyRoutableIp("")).toBe(false);
    expect(isPubliclyRoutableIp("acme.com")).toBe(false);
    expect(isPubliclyRoutableIp("010.0.0.1")).toBe(false);
    expect(isPubliclyRoutableIp("0x7f.0.0.1")).toBe(false);
    expect(isPubliclyRoutableIp("2130706433")).toBe(false); // decimal 127.0.0.1
  });
});

describe("parseIp", () => {
  it("dispatches on form", () => {
    expect(parseIp("8.8.8.8")?.version).toBe(4);
    expect(parseIp("::1")?.version).toBe(6);
    expect(parseIp("nope")).toBeNull();
  });
});
