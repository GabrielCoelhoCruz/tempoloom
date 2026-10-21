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

/** Who sees an event's details: CalDAV CLASS, or Google visibility. */
export type Visibility = "default" | "public" | "private";

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
  /** The organizer's email, lower case; "" when the event names none. */
  organizerEmail?: string;
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
  /** The event privacy: CalDAV CLASS, or Google visibility. */
  visibility: Visibility | "confidential";
  /** An instance of a recurring series: what the series master says. */
  series?: SeriesFacts;
}

/**
 * The master of a recurring series, as each of its instances carries it
 * (meetings-flexible-rescheduling.md rule 22: a series edit in the calendar).
 */
export interface SeriesFacts {
  /** The master's first start and end: its rule time and length. */
  start: number;
  end: number;
  /** The master's RRULE value, for example "FREQ=WEEKLY;BYDAY=TU". */
  rrule: string;
  summary: string;
  /** Guests of the master, lower case; optional ones in `optional`. */
  attendees: string[];
  optional: string[];
  /** This instance has its own data (a CalDAV override, a Google exception). */
  own: boolean;
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
  /**
   * The calendar server sends the guests nothing (RFC 6638 SCHEDULE-AGENT=CLIENT
   * on CalDAV; Tempoloom writes Google events without updates anyway).
   */
  quietGuests?: boolean;
  /** An all-day event on these local dates (end exclusive); `start` and `end` are then not written. */
  allDayDates?: { start: string; end: string };
  /** An RFC 5545 RRULE value, for example "FREQ=WEEKLY;BYDAY=WE": a recurring series. */
  recurrence?: string;
  /** A series' start and end are local times in this IANA zone, so it keeps them across DST. */
  timeZone?: string;
  /** Rule starts of a series that have no instance (RFC 5545 EXDATE). */
  exdates?: number[];
  /**
   * Calendar reminders (planning-notifications.md NTF-10, NTF-11): the
   * calendar's default ones, or alerts this many minutes before the start.
   * Missing: no reminders.
   */
  reminders?: { useDefault: true } | { minutes: number[] };
  /** Who sees the details (planning-event-content.md CNT-24). Missing: the calendar's default. */
  visibility?: Visibility;
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
  /**
   * The fields below change only what Tempoloom owns on a meeting occurrence,
   * so the organizer's other edits stay (meetings-flexible-rescheduling.md rule 22).
   */
  visibility?: Visibility;
  location?: string;
  colorId?: string | null;
  /** Replaces the event's alerts; `{ minutes: [] }` removes them. */
  reminders?: NonNullable<EventWrite["reminders"]>;
  /** Guests to add (or to change between required and optional) and guests to remove. */
  guests?: { add: { email: string; optional: boolean }[]; remove: string[] };
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

/** Display settings of the account (settings-profile.md PRF-2); a value the account lacks is left out. */
export interface ProfileSettings {
  weekStart?: 1 | 7;
  timeFormat?: "24h" | "12h";
  dateFormat?: "YMD" | "DMY" | "MDY";
}

export interface CalendarProvider {
  listCalendars(): Promise<ProviderCalendar[]>;
  /** Week start, time format and date format of the account. Only Google has them. */
  profileSettings?(): Promise<ProfileSettings>;
  /**
   * Busy intervals of other people's calendars, by email (Google free/busy).
   * An email with no data is left out of the map. Only Google has it.
   */
  freeBusy?(
    emails: string[],
    timeMin: number,
    timeMax: number,
  ): Promise<Map<string, { start: number; end: number }[]>>;
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
   * Changes only the given fields of one event, also of one instance of a
   * series (teams-policies.md rules 15-17; meetings-flexible-rescheduling.md
   * rule 22). A new time asks the guests again. With an etag, fails with
   * precondition_failed if the event changed.
   */
  editExternal(
    calendarId: string,
    eventId: string,
    change: ExternalChange,
    etag: string | null,
  ): Promise<ProviderEvent>;
  /**
   * Whether a change of an event with guests mails the guests (a CalDAV server
   * with scheduling, RFC 6638). Unknown counts as yes.
   */
  notifiesGuests?(calendarId: string): Promise<boolean>;
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
  /** The instances of a series in [from, to) (meetings-flexible.md rule 2: a new series). */
  seriesInstances?(
    calendarId: string,
    seriesId: string,
    from: number,
    to: number,
  ): Promise<ProviderEvent[]>;
  /**
   * Adds one instance to a series at `event`'s time, with `event`'s fields
   * (CalDAV RDATE and override): a period whose instance was removed gets one again.
   */
  addInstance?(calendarId: string, seriesId: string, event: EventWrite): Promise<ProviderEvent>;
  /**
   * Ends a series before `at` (RRULE UNTIL): later instances go, except the
   * instance ids in `keep`, which stay as they are. A series with no instance
   * left is deleted.
   */
  endSeries?(calendarId: string, seriesId: string, at: number, keep: string[]): Promise<void>;
}
