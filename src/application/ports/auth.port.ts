/**
 * The authentication port (Engineering-Rules §2.2): every external auth concern —
 * password hashing, session issuance, OAuth round-trips — sits behind this interface, so
 * use cases and routes never import an auth SDK.
 *
 * Cookie values are opaque `Set-Cookie` header strings: the edge forwards them verbatim
 * and never parses or reconstructs them.
 */
import type { Result } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";

export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
}

export interface AuthSession {
  readonly user: AuthenticatedUser;
  readonly expiresAt: Date;
}

/** A session plus the cookies the edge must set to establish it. */
export interface IssuedSession extends AuthSession {
  readonly setCookies: readonly string[];
}

export interface CredentialsInput {
  readonly email: string;
  readonly password: string;
  readonly name?: string;
  readonly ip?: string;
  readonly userAgent?: string;
}

export interface AuthGateway {
  signUpWithEmail(input: CredentialsInput): Promise<Result<IssuedSession, AppError>>;
  signInWithEmail(input: CredentialsInput): Promise<Result<IssuedSession, AppError>>;
  /** Returns the cookies that clear the session; revocation is server-side. */
  signOut(headers: Headers): Promise<readonly string[]>;
  /** Resolves the caller's session, or null when there isn't a valid one. */
  resolveSession(headers: Headers): Promise<AuthSession | null>;
  /** Begins an OAuth round-trip, returning the provider URL to redirect to. */
  socialSignInUrl(
    provider: "google",
    callbackUrl: string | undefined,
  ): Promise<Result<string, AppError>>;
  /**
   * Passthrough for the routes the auth library owns end to end (OAuth callbacks, token
   * exchange). Web-standard types only — no library type escapes this port.
   */
  handle(request: Request): Promise<Response>;
}
