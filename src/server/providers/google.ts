import { localToUtc } from "../../shared/time.ts";
import {
  GoogleApiError,
  type GoogleCalendarApi,
  type GoogleEvent,
  type GoogleEventInput,
  type GoogleEventTime,
  SyncTokenExpiredError,
} from "../google/calendar.ts";
import {
  type CalendarProvider,
  type EventChanges,
  type EventWrite,
  type ProviderCalendar,
  ProviderError,
  type ProviderEvent,
} from "./types.ts";

function toInstant(t: GoogleEventTime | undefined, zone: string): { ms: number; allDay: boolean } {
  if (t?.dateTime) return { ms: Date.parse(t.dateTime), allDay: false };
  if (t?.date) return { ms: localToUtc(t.timeZone ?? zone, t.date, 0), allDay: true };
  return { ms: 0, allDay: false };
}

export function fromGoogleEvent(e: GoogleEvent, zone: string): ProviderEvent {
  const start = toInstant(e.start, zone);
  const end = toInstant(e.end, zone);
  const self = e.attendees?.find((a) => a.self);
  return {
    id: e.id,
    cancelled: e.status === "cancelled" || !e.start || !e.end,
    etag: e.etag ?? null,
    summary: e.summary ?? "",
    description: e.description ?? "",
    location: e.location ?? "",
    start: start.ms,
    end: end.ms,
    allDay: start.allDay,
    busy: e.transparency !== "transparent",
    eventType: e.eventType ?? "default",
    selfResponse: self?.responseStatus ?? null,
    attendeeCount: e.attendees?.filter((a) => !a.resource).length ?? 0,
    attendees: (e.attendees ?? [])
      .filter((a) => !a.resource && a.email)
      .map((a) => (a.email ?? "").toLowerCase()),
    organizerSelf: e.organizer?.self !== false,
    recurringId: e.recurringEventId ?? null,
    colorId: e.colorId ?? null,
    updated: e.updated ? Date.parse(e.updated) : null,
    privateProps: e.extendedProperties?.private ?? {},
  };
}

function toGoogleEvent(w: EventWrite): GoogleEventInput {
  return {
    summary: w.summary,
    description: w.description,
    start: { dateTime: new Date(w.start).toISOString() },
    end: { dateTime: new Date(w.end).toISOString() },
    transparency: w.busy ? "opaque" : "transparent",
    ...(w.colorId ? { colorId: w.colorId } : {}),
    ...(w.location ? { location: w.location } : {}),
    ...(w.attendees || w.optionalAttendees
      ? {
          attendees: [
            ...(w.attendees ?? []).map((email) => ({ email })),
            ...(w.optionalAttendees ?? []).map((email) => ({ email, optional: true })),
          ],
        }
      : {}),
    reminders: { useDefault: false },
    extendedProperties: { private: w.privateProps },
  };
}

function mapError(err: unknown): never {
  if (err instanceof SyncTokenExpiredError) {
    throw new ProviderError("sync_token_expired", 410, err.message);
  }
  if (err instanceof GoogleApiError) {
    const kind =
      err.status === 412
        ? "precondition_failed"
        : err.status === 404 || err.status === 410
          ? "not_found"
          : err.status === 401
            ? "auth"
            : "other";
    throw new ProviderError(kind, err.status, err.message);
  }
  throw err;
}

export class GoogleProvider implements CalendarProvider {
  readonly #api: GoogleCalendarApi;
  readonly #zone: string;

  constructor(api: GoogleCalendarApi, zone: string) {
    this.#api = api;
    this.#zone = zone;
  }

  async listCalendars(): Promise<ProviderCalendar[]> {
    const list = await this.#api.listCalendars().catch(mapError);
    return list.map((c) => ({
      id: c.id,
      name: c.summary,
      primary: c.primary === true,
      writable: c.accessRole === "owner" || c.accessRole === "writer",
      timeZone: c.timeZone ?? null,
      color: c.backgroundColor ?? null,
    }));
  }

  async listEvents(
    calendarId: string,
    opts: { syncToken: string | null; timeMin: number; timeMax: number },
  ): Promise<EventChanges> {
    const page = await this.#api
      .listEvents(
        calendarId,
        opts.syncToken
          ? { syncToken: opts.syncToken }
          : { timeMin: opts.timeMin, timeMax: opts.timeMax },
      )
      .catch(mapError);
    return {
      events: page.events.map((e) => fromGoogleEvent(e, this.#zone)),
      nextSyncToken: page.nextSyncToken,
      full: !opts.syncToken,
    };
  }

  async insertEvent(calendarId: string, event: EventWrite): Promise<ProviderEvent> {
    const ev = await this.#api.insertEvent(calendarId, toGoogleEvent(event)).catch(mapError);
    return fromGoogleEvent(ev, this.#zone);
  }

  async updateEvent(
    calendarId: string,
    eventId: string,
    event: EventWrite,
    etag: string | null,
  ): Promise<ProviderEvent> {
    const ev = await this.#api
      .patchEvent(calendarId, eventId, toGoogleEvent(event), etag ? { etag } : {})
      .catch(mapError);
    return fromGoogleEvent(ev, this.#zone);
  }

  async setColor(
    calendarId: string,
    eventId: string,
    colorId: string | null,
    etag: string | null,
  ): Promise<ProviderEvent> {
    const ev = await this.#api
      .patchEvent(calendarId, eventId, { colorId: colorId ?? "" }, etag ? { etag } : {})
      .catch(mapError);
    return fromGoogleEvent(ev, this.#zone);
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    await this.#api.deleteEvent(calendarId, eventId).catch(mapError);
  }
}
