// Names of the built-in meeting checks (docs/specs/automations-meeting-quality.md),
// shown on the meeting checks page and in the automation list. Shared by the
// server and the client.
import type { CheckId } from "../server/meeting-prefs.ts";

export const CHECK_NAMES: Record<CheckId, string> = {
  conflict: "Overlapping commitments",
  attendee_availability: "Attendee declined or not free",
  rsvp_reminder: "Unanswered invitations",
  video_link: "Missing video link",
  agenda: "Agenda drafts",
};
