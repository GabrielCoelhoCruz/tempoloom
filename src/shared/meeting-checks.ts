// Names of the built-in meeting checks (docs/specs/automations-meeting-quality.md),
// shown on the meeting checks page and in the automation list, and the video
// link test that the video_link check and video-only buffers share. Shared by
// the server, the scheduler and the client.
import type { CheckId } from "../server/meeting-prefs.ts";

export const CHECK_NAMES: Record<CheckId, string> = {
  conflict: "Overlapping commitments",
  attendee_availability: "Attendee declined or not free",
  rsvp_reminder: "Unanswered invitations",
  video_link: "Missing video link",
  agenda: "Agenda drafts",
};

const VIDEO_HOST =
  /(zoom|meet|teams|webex|whereby|jit\.?si|gotomeet|chime|bluejeans|skype|bigbluebutton|video|call)/i;

/** A URL whose host names a video service (Tempoloom decision, video_link). */
export function hasVideoLink(text: string): boolean {
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')]+/gi)) {
    try {
      if (VIDEO_HOST.test(new URL(m[0]).hostname)) return true;
    } catch {}
  }
  return false;
}

/**
 * The one video link rule (automations-meeting-quality.md video_link;
 * buffers-automation.md has_video_link): a conference link (CalDAV
 * CONFERENCE, Google Meet), or a video service URL in the location or the
 * description. No conference given counts as none.
 */
export const hasVideo = (e: { conference?: string; location: string; description: string }) =>
  Boolean(e.conference) || hasVideoLink(e.location) || hasVideoLink(e.description);
