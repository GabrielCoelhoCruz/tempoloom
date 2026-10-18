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
  organizerSelf: boolean;
  recurringId: string | null;
  colorId: string | null;
  updated: number | null;
  /** Private key-value properties; Tempoloom marks its own events here. */
  privateProps: Record<string, string>;
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
}
