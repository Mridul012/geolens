/**
 * The AuthGateway implementation (docs/Backend.md §11).
 *
 * Everything Better Auth-shaped stops here: the port speaks domain values and web-standard
 * `Headers`/`Request`/`Response`, so routes and use cases never learn which library issues
 * sessions. Library failures are translated into the contract's stable error codes rather
 * than leaking status codes or vendor message strings.
 */
import { APIError } from "better-auth/api";
import type { Database } from "../db/prisma.js";
import type {
  AuthGateway,
  AuthSession,
  CredentialsInput,
  IssuedSession,
} from "../../application/ports/auth.port.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import {
  emailInUse,
  invalidCredentials,
  validationFailed,
} from "../../domain/shared/app-error.js";
import { createAuth, isGoogleConfigured, type AuthInstance } from "./better-auth.js";

interface SessionShape {
  readonly user: { readonly id: string; readonly email: string; readonly name?: string | null };
  readonly session: { readonly expiresAt: Date | string };
}

function toAuthSession(shape: SessionShape): AuthSession {
  return {
    user: {
      id: shape.user.id,
      email: shape.user.email,
      name: shape.user.name ?? null,
    },
    expiresAt: new Date(shape.session.expiresAt),
  };
}

/**
 * Better Auth signals failure with `APIError`. Map its documented codes onto ours; an
 * unrecognised one is a genuine fault and is rethrown so the error handler logs it rather
 * than dressing it up as a client mistake.
 */
function translate(error: unknown): AppError {
  if (!(error instanceof APIError)) {
    throw error;
  }
  const body = error.body as { code?: string; message?: string } | undefined;
  const code = body?.code ?? "";

  if (code.includes("USER_ALREADY_EXISTS") || code.includes("EMAIL_ALREADY")) {
    return emailInUse();
  }
  if (
    code.includes("INVALID_EMAIL_OR_PASSWORD") ||
    code.includes("INVALID_PASSWORD") ||
    code.includes("USER_NOT_FOUND") ||
    code.includes("CREDENTIAL_ACCOUNT_NOT_FOUND")
  ) {
    return invalidCredentials();
  }
  if (code.includes("PASSWORD_TOO_SHORT") || code.includes("PASSWORD_TOO_LONG")) {
    return validationFailed([
      { path: "password", message: body?.message ?? "Password does not meet requirements." },
    ]);
  }
  if (error.status === "UNAUTHORIZED") {
    return invalidCredentials();
  }
  throw error;
}

export class BetterAuthGateway implements AuthGateway {
  readonly #auth: AuthInstance;

  constructor(prisma: Database) {
    this.#auth = createAuth(prisma);
  }

  async signUpWithEmail(input: CredentialsInput): Promise<Result<IssuedSession, AppError>> {
    try {
      const result = await this.#auth.api.signUpEmail({
        body: {
          email: input.email,
          password: input.password,
          name: input.name ?? input.email,
        },
        headers: this.#requestHeaders(input),
        returnHeaders: true,
      });
      return ok(await this.#issued(result.headers));
    } catch (error) {
      return err(translate(error));
    }
  }

  async signInWithEmail(input: CredentialsInput): Promise<Result<IssuedSession, AppError>> {
    try {
      const result = await this.#auth.api.signInEmail({
        body: { email: input.email, password: input.password },
        headers: this.#requestHeaders(input),
        returnHeaders: true,
      });
      return ok(await this.#issued(result.headers));
    } catch (error) {
      return err(translate(error));
    }
  }

  async signOut(headers: Headers): Promise<readonly string[]> {
    const result = await this.#auth.api.signOut({ headers, returnHeaders: true });
    return result.headers.getSetCookie();
  }

  async resolveSession(headers: Headers): Promise<AuthSession | null> {
    const session = await this.#auth.api.getSession({ headers });
    return session === null ? null : toAuthSession(session as unknown as SessionShape);
  }

  async socialSignInUrl(
    provider: "google",
    callbackUrl: string | undefined,
  ): Promise<Result<string, AppError>> {
    if (!isGoogleConfigured()) {
      return err(
        validationFailed([{ path: "provider", message: "Google sign-in is not configured." }]),
      );
    }
    try {
      const result = await this.#auth.api.signInSocial({
        body: {
          provider,
          ...(callbackUrl === undefined ? {} : { callbackURL: callbackUrl }),
        },
      });
      const url = (result as { url?: string }).url;
      if (url === undefined) {
        return err(
          validationFailed([{ path: "provider", message: "Provider did not return a redirect." }]),
        );
      }
      return ok(url);
    } catch (error) {
      return err(translate(error));
    }
  }

  handle(request: Request): Promise<Response> {
    return this.#auth.handler(request);
  }

  /** Re-reads the freshly issued cookie so the caller gets a session, not just headers. */
  async #issued(responseHeaders: Headers): Promise<IssuedSession> {
    const setCookies = responseHeaders.getSetCookie();
    const cookieHeader = setCookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
    const session = await this.resolveSession(new Headers({ cookie: cookieHeader }));
    if (session === null) {
      throw new Error("Better Auth issued cookies that do not resolve to a session");
    }
    return { ...session, setCookies };
  }

  /** Session rows record the caller's IP and user agent for the audit trail. */
  #requestHeaders(input: CredentialsInput): Headers {
    const headers = new Headers();
    if (input.ip !== undefined) headers.set("x-forwarded-for", input.ip);
    if (input.userAgent !== undefined) headers.set("user-agent", input.userAgent);
    return headers;
  }
}
