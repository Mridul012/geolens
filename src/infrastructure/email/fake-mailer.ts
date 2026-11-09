/**
 * The fake mailer (mirrors `infrastructure/ai/adapters/fake.adapter.ts`): every send is
 * recorded rather than delivered, so local development, CI, and tests exercise the whole
 * notification path — composition, skip logic, templates — with no key and no inbox.
 * Refused in production by `config/env.ts`'s coherence check.
 */
import type { MailMessage, Mailer } from "../../application/ports/mailer.port.js";

export class FakeMailer implements Mailer {
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
}
