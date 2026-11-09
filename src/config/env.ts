// The single place environment variables are read and validated (Engineering-Rules §12).
// Parsed once at boot: a missing or malformed variable crashes the process with a named
// error naming every offending key — never at first use, deep inside a request.
import "dotenv/config";
import { z } from "zod";

/**
 * 12-factor platforms routinely set an unused variable to the empty string rather than
 * unsetting it. `FOO=` means absent, not "the empty URL".
 */
function optional<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => (value === "" ? undefined : value), schema.optional());
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  PORT: z.coerce.number().int().positive().default(3000),
  HEALTH_PORT_WORKER_BROWSER: z.coerce.number().int().positive().default(3001),
  HEALTH_PORT_WORKER_AI: z.coerce.number().int().positive().default(3002),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  SENTRY_DSN: optional(z.string().url()),

  // Postgres. Workers and api share the pooled endpoint (Engineering-Rules §13).
  DATABASE_URL: z.string().url(),
  /** Direct (unpooled) connection for migrations; falls back to DATABASE_URL. */
  DIRECT_DATABASE_URL: optional(z.string().url()),
  DATABASE_LOG_QUERIES: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  // Redis. BullMQ needs a real always-connected instance (docs/Backend.md §15).
  REDIS_URL: z.string().url(),

  // ─── HTTP surface ─────────────────────────────────────────────────────────
  /** Public origin of this API; used for problem `type` URIs and OAuth callbacks. */
  API_BASE_URL: z.string().url().default("http://localhost:3000"),
  /** Public origin of the web app; the default CORS allowlist entry. */
  APP_BASE_URL: z.string().url().default("http://localhost:3001"),
  /**
   * Comma-separated CORS allowlist. Strict by design: cookies ride on every request, so a
   * wildcard origin would be a CSRF hole (Engineering-Rules §12).
   */
  CORS_ORIGINS: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),

  // ─── Auth ─────────────────────────────────────────────────────────────────
  /** Signing secret for Better Auth; rotating it invalidates every live session. */
  AUTH_SECRET: z.string().min(32),
  AUTH_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),
  AUTH_COOKIE_DOMAIN: optional(z.string()),
  GOOGLE_CLIENT_ID: optional(z.string()),
  GOOGLE_CLIENT_SECRET: optional(z.string()),

  // ─── Object storage (Cloudflare R2; S3-compatible, MinIO locally) ─────────
  STORAGE_ENDPOINT: z.string().url(),
  STORAGE_REGION: z.string().default("auto"),
  STORAGE_BUCKET: z.string().min(1),
  STORAGE_ACCESS_KEY_ID: z.string().min(1),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1),
  /** MinIO needs path-style addressing; R2 and S3 accept it too. */
  STORAGE_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),

  // ─── Crawler ──────────────────────────────────────────────────────────────
  /** Identifies us to the sites we crawl, with a docs page (PRD security commitments). */
  CRAWLER_USER_AGENT: z
    .string()
    .default("VryseBot/1.0 (+https://vryse.example/bot; AI visibility analytics)"),
  CRAWLER_MAX_CONCURRENCY: z.coerce.number().int().positive().max(10).default(3),
  /** Politeness delay between requests to the same domain. */
  CRAWLER_DELAY_MS: z.coerce.number().int().min(0).default(500),
  CRAWLER_PAGE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /** Whole-crawl budget; a site that never finishes must still end (PRD NFR: <15 min p90). */
  CRAWLER_TIME_BUDGET_MS: z.coerce.number().int().positive().default(12 * 60_000),

  // ─── AI providers ─────────────────────────────────────────────────────────
  /**
   * `fake` answers every tier from the deterministic adapter: the whole pipeline runs with
   * no keys and no spend, which is how local development and CI work. Refused in
   * production, where a fabricated score would be indistinguishable from a real one.
   */
  AI_PROVIDER_MODE: z.enum(["live", "fake"]).default("fake"),
  OPENAI_API_KEY: optional(z.string().min(1)),
  ANTHROPIC_API_KEY: optional(z.string().min(1)),
  GROQ_API_KEY: optional(z.string().min(1)),
  GEMINI_API_KEY: optional(z.string().min(1)),
  PERPLEXITY_API_KEY: optional(z.string().min(1)),

  /** Per-crawl and per-run spend ceilings in micro-USD (PRD unit economics). */
  AI_BUDGET_PER_CRAWL_MICROS: z.coerce.number().int().positive().default(500_000),
  AI_BUDGET_PER_RUN_MICROS: z.coerce.number().int().positive().default(300_000),
  /** Trending-cost ceiling per project per rolling month; the budget monitor flags above it. */
  AI_BUDGET_PER_PROJECT_MONTHLY_MICROS: z.coerce.number().int().positive().default(5_000_000),

  // Langfuse tracing; unset simply means no traces (docs/Backend.md §7).
  LANGFUSE_PUBLIC_KEY: optional(z.string().min(1)),
  LANGFUSE_SECRET_KEY: optional(z.string().min(1)),
  LANGFUSE_BASE_URL: optional(z.string().url()),

  // ─── Email (Resend; docs/Backend.md §12) ───────────────────────────────────
  /**
   * `fake` records every send in memory instead of calling Resend: local development and
   * CI exercise the full notification path — composition, skip logic, templates — with no
   * key and no inbox to check. Refused in production, same reasoning as AI_PROVIDER_MODE.
   */
  EMAIL_PROVIDER_MODE: z.enum(["live", "fake"]).default("fake"),
  RESEND_API_KEY: optional(z.string().min(1)),
  EMAIL_FROM: z.string().email().default("notifications@vryse.example"),
  /** Failed-job sweeper and budget-monitor alerts; unset means "log only, no email". */
  OPS_ALERT_EMAIL: optional(z.string().email()),

  // ─── Billing (Stripe; docs/Backend.md §14) ─────────────────────────────────
  /**
   * `fake` skips Stripe entirely: checkout/portal return synthetic URLs, and the webhook
   * accepts a `BillingEvent` literal as its body instead of a signed Stripe envelope — the
   * whole checkout → webhook → entitlement-flip path is exercisable locally and in CI with
   * no Stripe account. Refused in production, same reasoning as the other provider modes.
   */
  STRIPE_MODE: z.enum(["live", "fake"]).default("fake"),
  STRIPE_SECRET_KEY: optional(z.string().min(1)),
  STRIPE_WEBHOOK_SECRET: optional(z.string().min(1)),
  /** The PRO plan's recurring Price id — there is only ever one paid price at launch. */
  STRIPE_PRO_PRICE_ID: optional(z.string().min(1)),

  // ─── Admin surfaces ───────────────────────────────────────────────────────
  /** Bull Board sits behind basic auth; unset credentials disable the route entirely. */
  ADMIN_USERNAME: optional(z.string().min(1)),
  ADMIN_PASSWORD: optional(z.string().min(12)),

  // ─── Rate limiting (Redis token buckets, Engineering-Rules §12) ────────────
  RATE_LIMIT_DEFAULT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_EXPENSIVE_PER_MINUTE: z.coerce.number().int().positive().default(5),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Cross-field rules the shape alone cannot express.
 *
 * Production must never run on the fake adapter: a fabricated score is indistinguishable
 * from a real one once it is in the database, and the product's whole claim is that its
 * numbers are trustworthy.
 */
function assertCoherent(env: Env): Env {
  const issues: string[] = [];
  if (env.NODE_ENV === "production" && env.AI_PROVIDER_MODE === "fake") {
    issues.push("AI_PROVIDER_MODE: cannot be \"fake\" in production");
  }
  if (env.NODE_ENV === "production" && env.EMAIL_PROVIDER_MODE === "fake") {
    issues.push("EMAIL_PROVIDER_MODE: cannot be \"fake\" in production");
  }
  if (env.EMAIL_PROVIDER_MODE === "live" && env.RESEND_API_KEY === undefined) {
    issues.push("RESEND_API_KEY: required when EMAIL_PROVIDER_MODE is \"live\"");
  }
  if (env.NODE_ENV === "production" && env.STRIPE_MODE === "fake") {
    issues.push("STRIPE_MODE: cannot be \"fake\" in production");
  }
  if (env.STRIPE_MODE === "live") {
    if (env.STRIPE_SECRET_KEY === undefined) {
      issues.push("STRIPE_SECRET_KEY: required when STRIPE_MODE is \"live\"");
    }
    if (env.STRIPE_WEBHOOK_SECRET === undefined) {
      issues.push("STRIPE_WEBHOOK_SECRET: required when STRIPE_MODE is \"live\"");
    }
    if (env.STRIPE_PRO_PRICE_ID === undefined) {
      issues.push("STRIPE_PRO_PRICE_ID: required when STRIPE_MODE is \"live\"");
    }
  }
  if (issues.length > 0) {
    throw new InvalidEnvironmentError(
      `Invalid environment configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`,
    );
  }
  return env;
}

export class InvalidEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEnvironmentError";
  }
}

/**
 * Validates a raw environment record against the schema.
 *
 * Exported separately from {@link env} so tests can exercise failure modes without
 * mutating `process.env`.
 *
 * @throws {InvalidEnvironmentError} when any variable is missing or malformed.
 */
export function parseEnv(source: NodeJS.ProcessEnv | Record<string, unknown>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new InvalidEnvironmentError(`Invalid environment configuration:\n${issues}`);
  }
  return assertCoherent(result.data);
}

export const env: Env = parseEnv(process.env);
