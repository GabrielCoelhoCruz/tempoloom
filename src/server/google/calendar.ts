// Minimal typed client for the Google Calendar v3 REST API.
// https://developers.google.com/calendar/api/v3/reference

const API = "https://www.googleapis.com/calendar/v3";

export interface GoogleCalendarListEntry {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole: "freeBusyReader" | "reader" | "writer" | "owner";
  timeZone?: string;
  backgroundColor?: string;
  selected?: boolean;
}

export interface GoogleEventTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface GoogleAttendee {
  email: string;
  self?: boolean;
  organizer?: boolean;
  responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
  optional?: boolean;
  resource?: boolean;
  /** The attendee's note to the organizer with the answer. */
  comment?: string;
}

export interface GoogleEvent {
  id: string;
  status: "confirmed" | "tentative" | "cancelled";
  etag?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  transparency?: "opaque" | "transparent";
  visibility?: "default" | "public" | "private" | "confidential";
  colorId?: string;
  recurringEventId?: string;
  originalStartTime?: GoogleEventTime;
  attendees?: GoogleAttendee[];
  organizer?: { email?: string; self?: boolean };
  eventType?:
    | "default"
    | "outOfOffice"
    | "focusTime"
    | "workingLocation"
    | "birthday"
    | "fromGmail";
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
  updated?: string;
  hangoutLink?: string;
  conferenceData?: unknown;
  recurrence?: string[];
  reminders?: { useDefault: boolean; overrides?: { method: string; minutes: number }[] };
}

export type GoogleEventInput = Omit<
  GoogleEvent,
  "id" | "status" | "etag" | "updated" | "recurringEventId" | "organizer"
> & { id?: string; status?: GoogleEvent["status"] };

export class GoogleApiError extends Error {
  readonly status: number;
  readonly reason: string;
  constructor(status: number, reason: string, message: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

/** The sync token expired; the caller must run a full sync. */
export class SyncTokenExpiredError extends GoogleApiError {}

export interface EventPage {
  events: GoogleEvent[];
  /** Null when Google returns no token; the caller then reads the full window each time. */
  nextSyncToken: string | null;
}

export interface CalendarApiOptions {
  getAccessToken: () => Promise<string>;
  /** Base URL override, used only to point at a recording proxy. */
  baseUrl?: string;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "backendError"]);

export class GoogleCalendarApi {
  readonly #opts: Required<Omit<CalendarApiOptions, "baseUrl">> & { baseUrl: string };

  constructor(opts: CalendarApiOptions) {
    this.#opts = {
      baseUrl: opts.baseUrl ?? API,
      maxAttempts: opts.maxAttempts ?? 5,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      getAccessToken: opts.getAccessToken,
    };
  }

  async #request<T>(
    method: string,
    path: string,
    query?: Record<string, string | undefined>,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(this.#opts.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {}))
      if (v !== undefined) url.searchParams.set(k, v);
    for (let attempt = 1; ; attempt++) {
      const token = await this.#opts.getAccessToken();
      const res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (res.status === 204) return undefined as T;
      const json = (await res.json().catch(() => ({}))) as {
        error?: { code?: number; message?: string; errors?: { reason?: string }[] };
      };
      if (res.ok) return json as T;
      const reason = json.error?.errors?.[0]?.reason ?? `http_${res.status}`;
      const message = json.error?.message ?? res.statusText;
      if (res.status === 410) throw new SyncTokenExpiredError(410, reason, message);
      const retryable =
        res.status === 429 ||
        res.status >= 500 ||
        (res.status === 403 && RETRY_REASONS.has(reason));
      if (!retryable || attempt >= this.#opts.maxAttempts) {
        throw new GoogleApiError(res.status, reason, message);
      }
      await this.#opts.sleep(Math.min(32_000, 500 * 2 ** (attempt - 1)) + Math.random() * 250);
    }
  }

  async listCalendars(): Promise<GoogleCalendarListEntry[]> {
    const out: GoogleCalendarListEntry[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.#request<{
        items?: GoogleCalendarListEntry[];
        nextPageToken?: string;
      }>("GET", "/users/me/calendarList", { maxResults: "250", pageToken });
      out.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  /** Creates a secondary calendar owned by the authenticated account. */
  createCalendar(summary: string, timeZone: string): Promise<{ id: string; summary: string }> {
    return this.#request("POST", "/calendars", undefined, { summary, timeZone });
  }

  async deleteCalendar(calendarId: string): Promise<void> {
    try {
      await this.#request("DELETE", `/calendars/${encodeURIComponent(calendarId)}`);
    } catch (err) {
      if (err instanceof GoogleApiError && (err.status === 404 || err.status === 410)) return;
      throw err;
    }
  }

  /**
   * Lists events with recurring series expanded into instances. Without a sync
   * token it runs a full sync of the window; with one it returns only changes
   * (cancelled events included) since that token was issued.
   */
  async listEvents(
    calendarId: string,
    opts: { syncToken?: string; timeMin?: number; timeMax?: number },
  ): Promise<EventPage> {
    const events: GoogleEvent[] = [];
    let pageToken: string | undefined;
    for (;;) {
      const query: Record<string, string | undefined> = {
        singleEvents: "true",
        showDeleted: "true",
        maxResults: "2500",
        pageToken,
      };
      if (opts.syncToken) query.syncToken = opts.syncToken;
      else {
        if (opts.timeMin !== undefined) query.timeMin = new Date(opts.timeMin).toISOString();
        if (opts.timeMax !== undefined) query.timeMax = new Date(opts.timeMax).toISOString();
      }
      const page = await this.#request<{
        items?: GoogleEvent[];
        nextPageToken?: string;
        nextSyncToken?: string;
      }>("GET", `/calendars/${encodeURIComponent(calendarId)}/events`, query);
      events.push(...(page.items ?? []));
      if (page.nextPageToken) {
        pageToken = page.nextPageToken;
        continue;
      }
      return { events, nextSyncToken: page.nextSyncToken ?? null };
    }
  }

  getEvent(calendarId: string, eventId: string): Promise<GoogleEvent> {
    return this.#request(
      "GET",
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    );
  }

  insertEvent(
    calendarId: string,
    event: GoogleEventInput,
    opts: { sendUpdates?: "all" | "none"; conference?: boolean } = {},
  ): Promise<GoogleEvent> {
    return this.#request(
      "POST",
      `/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        sendUpdates: opts.sendUpdates ?? "none",
        ...(opts.conference ? { conferenceDataVersion: "1" } : {}),
      },
      event,
    );
  }

  /** Patches an event. With an etag, Google rejects the write (412) if the event changed. */
  patchEvent(
    calendarId: string,
    eventId: string,
    patch: Partial<GoogleEventInput>,
    opts: { etag?: string; sendUpdates?: "all" | "none" } = {},
  ): Promise<GoogleEvent> {
    return this.#request(
      "PATCH",
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { sendUpdates: opts.sendUpdates ?? "none" },
      patch,
      opts.etag ? { "if-match": opts.etag } : undefined,
    );
  }

  async deleteEvent(
    calendarId: string,
    eventId: string,
    opts: { sendUpdates?: "all" | "none" } = {},
  ): Promise<void> {
    try {
      await this.#request(
        "DELETE",
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        { sendUpdates: opts.sendUpdates ?? "none" },
      );
    } catch (err) {
      // Deleting an event that is already gone is a success.
      if (err instanceof GoogleApiError && (err.status === 404 || err.status === 410)) return;
      throw err;
    }
  }

  async freeBusy(
    calendarIds: string[],
    timeMin: number,
    timeMax: number,
  ): Promise<Map<string, { start: number; end: number }[]>> {
    const res = await this.#request<{
      calendars: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }>;
    }>("POST", "/freeBusy", undefined, {
      timeMin: new Date(timeMin).toISOString(),
      timeMax: new Date(timeMax).toISOString(),
      items: calendarIds.map((id) => ({ id })),
    });
    const out = new Map<string, { start: number; end: number }[]>();
    for (const [id, cal] of Object.entries(res.calendars ?? {})) {
      out.set(
        id,
        (cal.busy ?? []).map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) })),
      );
    }
    return out;
  }
}
