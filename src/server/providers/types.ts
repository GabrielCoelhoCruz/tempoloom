// One interface for every calendar backend (Google OAuth, Google service
// account, CalDAV). Sync and push code use only these types.

export interface ProviderCalendar {
  id: string;
  name: string;
  primary: boolean;
  writable: boolean;
  timeZone: string | null;
  color: string | null;
}

export type ResponseStatus = "needsAction" | "declined" | "tentative" | "accepted";

export interface ProviderEvent {
  id: string;
  cancelled: boolean;
  etag: string | null;
  summary: string;
  description: string;
  location: string;
  start: number;
  end: number;
  allDay: boolean;
  busy: boolean;
  /** Google event type, or "default". */
  eventType: string;
  selfResponse: ResponseStatus | null;
  attendeeCount: number;
  /** Attendee emails, lower case. */
  attendees: string[];
  organizerSelf: boolean;
  recurringId: string | null;
  colorId: string | null;
  updated: number | null;
  /** Private key-value properties; Tempoloom marks its own events here. */
  privateProps: Record<string, string>;
  /** The user's own note with the answer to an invitation (events-tags.md), or "". */
  rsvpNote?: string;
  /** Each guest's answer, by lower-case email (meeting checks, meeting declines). */
  responses?: Record<string, ResponseStatus>;
  /** The event's conference link (CalDAV CONFERENCE, Google Meet), or "". */
  conference?: string;
  /** The event alerts: a VALARM, or Google reminders. Mirroring copies never do. */
  alerts?: boolean;
}

export interface EventWrite {
  summary: string;
  description: string;
  start: number;
  end: number;
  busy: boolean;
  colorId: string | null;
  privateProps: Record<string, string>;
  location?: string;
  attendees?: string[];
  /** Guests whose answer and availability do not count. */
  optionalAttendees?: string[];
  /** The organizer's email, written when the event has guests. */
  organizer?: string;
  /** An all-day event on these local dates (end exclusive); `start` and `end` are then not written. */
  allDayDates?: { start: string; end: string };
  /** An RFC 5545 RRULE value, for example "FREQ=WEEKLY;BYDAY=WE": a recurring series. */
  recurrence?: string;
  /**
   * Calendar reminders (planning-notifications.md NTF-10, NTF-11): the
   * calendar's default ones, or alerts this many minutes before the start.
   * Missing: no reminders.
   */
  reminders?: { useDefault: true } | { minutes: number[] };
  /** Who sees the details (planning-event-content.md CNT-24). Missing: the calendar's default. */
  visibility?: "default" | "public" | "private";
}

/** A change to an event someone else may organize; every other field stays as it is. */
export interface ExternalChange {
  /** A new title (events-title-emoji.md rules 5 and 8; preview mode apply). */
  summary?: string;
  /** The user's own answer to the invitation. */
  selfResponse?: ResponseStatus;
  /** A note to the organizer with the answer (focus-time.md rule 23). */
  comment?: string;
  description?: string;
  /** Busy or free (events-tags.md rule 14, quick block). */
  busy?: boolean;
  end?: number;
  /** A new start, for an event the user organizes (preview mode apply). */
  start?: number;
}

export interface EventChanges {
  events: ProviderEvent[];
  /** Opaque token for the next incremental read; null when the backend gives none. */
  nextSyncToken: string | null;
  /** True when `events` is the complete window, so the caller replaces its copy. */
  full: boolean;
}

export type ProviderErrorKind =
  | "precondition_failed"
  | "not_found"
  | "sync_token_expired"
  | "auth"
  | "other";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number;
  constructor(kind: ProviderErrorKind, status: number, message: string) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export interface CalendarProvider {
  listCalendars(): Promise<ProviderCalendar[]>;
  /**
   * Reads events in [timeMin, timeMax) with recurring series expanded. With a
   * sync token, the backend may return only the changes since that token.
   */
  listEvents(
    calendarId: string,
    opts: { syncToken: string | null; timeMin: number; timeMax: number },
  ): Promise<EventChanges>;
  insertEvent(calendarId: string, event: EventWrite): Promise<ProviderEvent>;
  /** Replaces a managed event. With an etag, fails with precondition_failed if it changed. */
  updateEvent(
    calendarId: string,
    eventId: string,
    event: EventWrite,
    etag: string | null,
  ): Promise<ProviderEvent>;
  /** Deletes an event. Deleting an event that is already gone succeeds. */
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
  /**
   * Sets only the color of an event (events-categories-and-colors.md rules 6-8);
   * every other field stays as it is. For a series, `eventId` is the series.
   */
  setColor(
    calendarId: string,
    eventId: string,
    colorId: string | null,
    etag: string | null,
  ): Promise<ProviderEvent>;
  /**
   * Changes the title, the user's answer, the description or the end of one event
   * (teams-policies.md rules 15-17). With an etag, fails with precondition_failed
   * if the event changed.
   */
  editExternal(
    calendarId: string,
    eventId: string,
    change: ExternalChange,
    etag: string | null,
  ): Promise<ProviderEvent>;
  /**
   * Sets the private properties of a whole recurring series, the series and
   * every changed instance; other fields stay as they are (meetings-flexible.md
   * rule 1: an adopted series). Instance ids of a series work with updateEvent
   * (that one instance) and deleteEvent (cancel that instance).
   */
  setSeriesProps?(
    calendarId: string,
    seriesId: string,
    props: Record<string, string>,
  ): Promise<void>;
}
