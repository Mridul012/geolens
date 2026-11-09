/**
 * Email behind a port (Engineering-Rules §2.2, and named directly in CLAUDE.md's port
 * list). A use case composes a message; it never learns whether Resend or a fake in-memory
 * recorder actually delivered it.
 */
export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}
