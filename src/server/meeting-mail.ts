// The cancel email of a deleted flexible meeting (docs/specs/
// meetings-flexible-rescheduling.md rule 28). Tempoloom writes calendars
// without the provider's guest emails, so it tells the guests itself.
// Without SMTP_URL nothing is sent and the delete page offers no email.

import type { Mailer } from "./mail.ts";
import { when } from "./preview.ts";

export interface MeetingCancel {
  organizer: string;
  title: string;
  /** The organizer's time zone; the times are written in it. */
  zone: string;
  /** The cancelled occurrences that are on the calendars. */
  times: { start: number; end: number }[];
  guests: string[];
}

/** Sends the cancel email to each guest in the background; a failure is logged, never thrown. */
export function notifyMeetingCancelled(mailer: Mailer, c: MeetingCancel): void {
  if (!mailer.configured || c.times.length === 0) return;
  const text = [
    `${c.organizer} cancelled "${c.title}". These times are cancelled:`,
    "",
    ...c.times.map((t) => `- ${when(c.zone, t.start, t.end)}`),
    "",
    `Times are in ${c.zone}.`,
  ].join("\n");
  void (async () => {
    for (const to of c.guests) {
      try {
        await mailer.send({ to, subject: `Cancelled: ${c.title}`, text });
      } catch (err) {
        console.error(`meeting cancel email to ${to} failed`, err);
      }
    }
  })();
}
