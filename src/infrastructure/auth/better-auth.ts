/**
 * Better Auth wiring (docs/Backend.md §11; schema mapping per docs/adr/0002).
 *
 * Identity lives in our own Postgres: no per-MAU vendor bill, no webhook sync between an
 * auth SaaS and our database. Better Auth's models are mapped onto the documented tables
 * by name, so the physical schema stays the one the Database doc describes.
 */
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import type { Database } from "../db/prisma.js";
import { env } from "../../config/env.js";
import { newUuidV7 } from "../db/uuid.js";

/** The session cookie name the API contract publishes (docs/API.md §3 securitySchemes). */
export const SESSION_COOKIE_NAME = "geolens.session";

// The return type is inferred rather than annotated: Better Auth's `Auth<Options>` is
// generic over the exact options object, and widening it to `Auth<BetterAuthOptions>`
// discards the mapping this file establishes.
export function createAuth(prisma: Database) {
  const googleConfigured =
    env.GOOGLE_CLIENT_ID !== undefined && env.GOOGLE_CLIENT_SECRET !== undefined;

  return betterAuth({
    appName: "GEOlens",
    baseURL: env.API_BASE_URL,
    basePath: "/v1/auth",
    secret: env.AUTH_SECRET,
    trustedOrigins: [env.APP_BASE_URL, ...env.CORS_ORIGINS],

    database: prismaAdapter(prisma, { provider: "postgresql" }),

    emailAndPassword: {
      enabled: true,
      // The contract's sign-up schema requires 10 characters; keep the engine in step.
      minPasswordLength: 10,
      maxPasswordLength: 200,
      autoSignIn: true,
    },

    ...(googleConfigured
      ? {
          socialProviders: {
            google: {
              clientId: env.GOOGLE_CLIENT_ID as string,
              clientSecret: env.GOOGLE_CLIENT_SECRET as string,
            },
          },
        }
      : {}),

    // ── Schema mapping onto the documented tables (ADR 0002) ─────────────────
    user: {
      modelName: "user",
      fields: { image: "imageUrl" },
    },
    session: {
      modelName: "session",
      fields: { ipAddress: "ip" },
      expiresIn: env.AUTH_SESSION_TTL_SECONDS,
      updateAge: Math.floor(env.AUTH_SESSION_TTL_SECONDS / 4),
    },
    account: {
      modelName: "oauthAccount",
      fields: { providerId: "provider", accountId: "providerAccountId" },
    },
    verification: { modelName: "verification" },

    advanced: {
      // App-supplied UUIDv7 keeps identity inserts right-leaning like every other table
      // (docs/Database.md §1.1).
      database: { generateId: () => newUuidV7() },
      cookiePrefix: "geolens",
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        secure: env.NODE_ENV === "production",
        path: "/",
        ...(env.AUTH_COOKIE_DOMAIN === undefined ? {} : { domain: env.AUTH_COOKIE_DOMAIN }),
      },
      cookies: { session_token: { name: SESSION_COOKIE_NAME } },
    },

    databaseHooks: {
      user: {
        // `email_verified_at` is the human-meaningful timestamp the schema doc specifies;
        // Better Auth only knows the boolean, so keep the two in step (ADR 0002).
        update: {
          before: async (user: Record<string, unknown>) => {
            if (user["emailVerified"] === true && user["emailVerifiedAt"] == null) {
              return { data: { ...user, emailVerifiedAt: new Date() } };
            }
            return { data: user };
          },
        },
      },
    },
  });
}

export function isGoogleConfigured(): boolean {
  return env.GOOGLE_CLIENT_ID !== undefined && env.GOOGLE_CLIENT_SECRET !== undefined;
}

export type AuthInstance = ReturnType<typeof createAuth>;
