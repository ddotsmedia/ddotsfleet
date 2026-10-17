import { Logger } from "@nestjs/common";

export const MAIL_TRANSPORT = Symbol("MAIL_TRANSPORT");

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface MailTransport {
  send(message: MailMessage): Promise<void>;
}

/**
 * Default transport until a real provider is configured. It records only the recipient and
 * subject. It never logs the body, because the body carries invitation tokens.
 */
export class LogMailTransport implements MailTransport {
  private readonly logger = new Logger("Mail");

  async send(message: MailMessage): Promise<void> {
    this.logger.log(`mail queued: to=${message.to} subject="${message.subject}"`);
  }
}
