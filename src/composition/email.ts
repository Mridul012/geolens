/**
 * The only place a mailer is constructed (mirrors `composition/ai.ts`'s role for provider
 * adapters). `EMAIL_PROVIDER_MODE=fake` wires the in-memory recorder so the whole
 * notification path is exercised locally and in CI with no key and no inbox.
 */
import type { Mailer } from "../application/ports/mailer.port.js";
import { FakeMailer } from "../infrastructure/email/fake-mailer.js";
import { ResendMailer } from "../infrastructure/email/resend-mailer.js";
import { env } from "../config/env.js";

export function createMailer(): Mailer {
  if (env.EMAIL_PROVIDER_MODE === "fake") return new FakeMailer();

  if (env.RESEND_API_KEY === undefined) {
    // `config/env.ts`'s coherence check already refuses this combination at boot; this is
    // the type-level guard for the branch that check exists to prevent.
    throw new Error('RESEND_API_KEY is required when EMAIL_PROVIDER_MODE is "live"');
  }
  return new ResendMailer(env.RESEND_API_KEY, env.EMAIL_FROM);
}
