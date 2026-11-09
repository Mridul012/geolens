import { describe, expect, it } from "vitest";
import { InvalidEnvironmentError, parseEnv } from "../../../src/config/env.js";

const valid = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://geolens:geolens@localhost:5432/geolens",
  REDIS_URL: "redis://localhost:6379",
  AUTH_SECRET: "test-secret-0123456789abcdef0123456789",
  STORAGE_ENDPOINT: "http://localhost:9000",
  STORAGE_BUCKET: "geolens-test",
  STORAGE_ACCESS_KEY_ID: "key",
  STORAGE_SECRET_ACCESS_KEY: "secret",
} as const;

describe("parseEnv", () => {
  it("applies documented defaults when optional variables are absent", () => {
    const env = parseEnv(valid);
    expect(env.PORT).toBe(3000);
    expect(env.HEALTH_PORT_WORKER_BROWSER).toBe(3001);
    expect(env.HEALTH_PORT_WORKER_AI).toBe(3002);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.SENTRY_DSN).toBeUndefined();
  });

  it("coerces numeric variables from their string form", () => {
    expect(parseEnv({ ...valid, PORT: "8080" }).PORT).toBe(8080);
  });

  it("throws a named error listing every offending key", () => {
    expect(() => parseEnv({})).toThrow(InvalidEnvironmentError);
    try {
      parseEnv({ NODE_ENV: "staging", PORT: "not-a-number", LOG_LEVEL: "chatty" });
      expect.unreachable("expected parseEnv to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidEnvironmentError);
      const message = (error as Error).message;
      expect(message).toContain("NODE_ENV");
      expect(message).toContain("PORT");
      expect(message).toContain("LOG_LEVEL");
    }
  });

  it("rejects a malformed Sentry DSN rather than ignoring it", () => {
    expect(() => parseEnv({ ...valid, SENTRY_DSN: "nope" })).toThrow(InvalidEnvironmentError);
  });

  it("requires a database URL", () => {
    expect(() => parseEnv({ NODE_ENV: "test" })).toThrow(/DATABASE_URL/);
  });

  it("applies crawler defaults, including an identifying user agent", () => {
    const env = parseEnv(valid);
    expect(env.CRAWLER_USER_AGENT).toContain("GEOlensBot");
    // PRD security commitment: our crawler identifies itself and links to a docs page.
    expect(env.CRAWLER_USER_AGENT).toContain("+https://");
    expect(env.CRAWLER_MAX_CONCURRENCY).toBe(3);
    expect(env.CRAWLER_DELAY_MS).toBe(500);
  });

  it("requires a Redis URL and a signing secret of usable length", () => {
    expect(() => parseEnv({ NODE_ENV: "test", DATABASE_URL: valid.DATABASE_URL })).toThrow(
      /REDIS_URL/,
    );
    expect(() => parseEnv({ ...valid, AUTH_SECRET: "too-short" })).toThrow(/AUTH_SECRET/);
  });

  it("splits the CORS allowlist and drops empty entries", () => {
    expect(parseEnv(valid).CORS_ORIGINS).toEqual([]);
    expect(
      parseEnv({ ...valid, CORS_ORIGINS: "https://a.test, https://b.test ,," }).CORS_ORIGINS,
    ).toEqual(["https://a.test", "https://b.test"]);
  });

  it("treats an empty optional variable as unset, the way platforms emit them", () => {
    const env = parseEnv({ ...valid, SENTRY_DSN: "", DIRECT_DATABASE_URL: "" });
    expect(env.SENTRY_DSN).toBeUndefined();
    expect(env.DIRECT_DATABASE_URL).toBeUndefined();
  });

  it("parses the query-logging switch into a boolean", () => {
    expect(parseEnv(valid).DATABASE_LOG_QUERIES).toBe(false);
    expect(parseEnv({ ...valid, DATABASE_LOG_QUERIES: "true" }).DATABASE_LOG_QUERIES).toBe(true);
  });

  it("defaults to the fake email provider, recording sends instead of spending", () => {
    expect(parseEnv(valid).EMAIL_PROVIDER_MODE).toBe("fake");
  });

  it("refuses a fake AI or email provider in production", () => {
    expect(() => parseEnv({ ...valid, NODE_ENV: "production" })).toThrow(/AI_PROVIDER_MODE/);
    expect(() =>
      parseEnv({ ...valid, NODE_ENV: "production", AI_PROVIDER_MODE: "live" }),
    ).toThrow(/EMAIL_PROVIDER_MODE/);
  });

  it("requires a Resend key when the email provider is live", () => {
    expect(() => parseEnv({ ...valid, EMAIL_PROVIDER_MODE: "live" })).toThrow(/RESEND_API_KEY/);
    expect(() =>
      parseEnv({ ...valid, EMAIL_PROVIDER_MODE: "live", RESEND_API_KEY: "re_test" }),
    ).not.toThrow();
  });

  it("defaults to the fake Stripe mode, and refuses it in production", () => {
    expect(parseEnv(valid).STRIPE_MODE).toBe("fake");
    expect(() =>
      parseEnv({ ...valid, NODE_ENV: "production", AI_PROVIDER_MODE: "live", EMAIL_PROVIDER_MODE: "live", RESEND_API_KEY: "re_test" }),
    ).toThrow(/STRIPE_MODE/);
  });

  it("requires Stripe secrets and a price id when Stripe mode is live", () => {
    expect(() => parseEnv({ ...valid, STRIPE_MODE: "live" })).toThrow(/STRIPE_SECRET_KEY/);
    expect(() =>
      parseEnv({ ...valid, STRIPE_MODE: "live", STRIPE_SECRET_KEY: "sk_test" }),
    ).toThrow(/STRIPE_WEBHOOK_SECRET/);
    expect(() =>
      parseEnv({
        ...valid,
        STRIPE_MODE: "live",
        STRIPE_SECRET_KEY: "sk_test",
        STRIPE_WEBHOOK_SECRET: "whsec_test",
      }),
    ).toThrow(/STRIPE_PRO_PRICE_ID/);
    expect(() =>
      parseEnv({
        ...valid,
        STRIPE_MODE: "live",
        STRIPE_SECRET_KEY: "sk_test",
        STRIPE_WEBHOOK_SECRET: "whsec_test",
        STRIPE_PRO_PRICE_ID: "price_test",
      }),
    ).not.toThrow();
  });
});
