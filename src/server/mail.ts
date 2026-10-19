// Outgoing email over SMTP (invitations). Without SMTP_URL nothing is sent and
// the UI offers the links to copy instead.
import { createTransport } from "nodemailer";

export interface Message {
  to: string;
  subject: string;
  text: string;
  /** An iCalendar invitation (iMIP), for example a meeting update. */
  icalEvent?: { method: string; content: string };
  /** An HTML part besides the text, for example with branding. */
  html?: string;
}

export interface Mailer {
  readonly configured: boolean;
  send(m: Message): Promise<void>;
}

export function createMailer(url: string | undefined, from: string): Mailer {
  if (!url) {
    return {
      configured: false,
      send: async () => {
        throw new Error("SMTP_URL is not set");
      },
    };
  }
  const transport = createTransport(url);
  return {
    configured: true,
    async send(m) {
      await transport.sendMail({ from, ...m });
    },
  };
}
