# ADR 0002 — Extend the identity tables so Better Auth can own auth flows

**Status:** Accepted (M3)
**Deviates from:** `docs/Database.md` §2.1–2.2 (`users`, `sessions`, `oauth_accounts`).
**Approved by:** product owner, in-session, 2026-08-30.

## Context

`CLAUDE.md` locks **Better Auth** as the authentication technology, and
`docs/Backend.md` §11 explains why: identity data stays in our own Postgres, with no
per-MAU vendor bill and no webhook sync between an auth SaaS and our database.
`docs/Database.md` §2.1 states the intent plainly — "Better Auth manages auth flows;
these tables are its storage, owned by us in our Postgres."

The tables as documented cannot serve that role unchanged. Better Auth's core schema needs:

| Better Auth field | Documented schema | Gap |
|---|---|---|
| `user.emailVerified` (boolean) | `email_verified_at timestamptz` | type mismatch |
| `session.updatedAt` | — | missing column |
| `account.password` | `users.password_hash` | wrong table |
| `account.{accessToken, refreshToken, idToken, scope, …}` | — | missing columns |
| `verification` table | — | missing table |

Leaving the gap unresolved means either abandoning the locked stack or running Better Auth
on a second set of tables — the "two sources of truth for identity" trade the Backend doc
explicitly rejected when it chose Better Auth over Clerk.

## Decision

Extend the documented tables additively, and map Better Auth's models onto them with
`modelName` / `fields` so the physical schema keeps the documented names:

- `users`: add `email_verified boolean not null default false`. `email_verified_at` is
  **kept** as the human-meaningful timestamp and maintained by a Better Auth database hook
  whenever the boolean flips.
- `users`: **drop** `password_hash`. Better Auth stores credential secrets on the account
  row alongside every other provider credential. A retained-but-unused password column is
  a security foot-gun: it invites code that writes a password the auth layer never reads.
- `sessions`: add `updated_at`.
- `oauth_accounts`: add `updated_at`, `password`, `access_token`, `refresh_token`,
  `id_token`, `access_token_expires_at`, `refresh_token_expires_at`, `scope`, and
  `issuer` (Better Auth's issuer discriminator, with its `UNIQUE (issuer, account_id)`). The table now
  holds every credential type, which is what its `UNIQUE (provider, provider_account_id)`
  already implied; `provider` carries `"credential"` for email/password accounts.
- New `verifications` table (`id`, `identifier`, `value`, `expires_at`, timestamps) for
  email-verification and password-reset tokens.

Ids stay app-supplied UUIDv7 (`docs/Database.md` §1.1) via Better Auth's `generateId` hook.

## Consequences

- **Positive:** the locked stack ships as intended — email/password and Google OAuth,
  DB-backed revocable sessions, no second identity store, no vendor bill.
- **Positive:** one table now holds all credentials, so revoking a user's access is one
  `DELETE ... WHERE user_id = $1` regardless of provider.
- **Negative:** `docs/Database.md` §2.1–2.2 no longer describes the columns exactly. The
  migration comment and this ADR record the delta; the doc should be amended at the next
  revision.
- **Negative:** dropping `password_hash` is destructive in principle. It is safe here —
  the column has never held a row, and this migration is the first to touch identity.
- **Neutral:** every added column is nullable or defaulted, so the migration is
  expand-only and zero-downtime by construction (Engineering-Rules §5).
