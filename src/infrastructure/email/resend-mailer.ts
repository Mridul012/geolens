/**
 * Mailer over Resend (docs/Backend.md §12 — "simple, good deliverability, team knows it").
 * Legal home for the provider SDK: infra implements the port, nothing else touches Resend.
 */
import { Resend } from "resend";
import type { MailMessage, Mailer } from "../../application/ports/mailer.port.js";

export class ResendMailer implements Mailer {
  readonly #client: Resend;
  readonly #from: string;

  constructor(apiKey: string, from: string) {
    this.#client = new Resend(apiKey);
    this.#from = from;
  }

  async send(message: MailMessage): Promise<void> {
    const result = await this.#client.emails.send({
      from: this.#from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
    if (result.error !== null) {
      throw new Error(`Resend send failed: ${result.error.message}`);
    }
  }
}
