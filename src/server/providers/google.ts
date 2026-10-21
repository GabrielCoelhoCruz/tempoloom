import { localToUtc } from "../../shared/time.ts";
import {
  GoogleApiError,
  type GoogleCalendarApi,
  type GoogleEvent,
  type GoogleEventInput,
  type GoogleEventTime,
  SyncTokenExpiredError,
} from "../google/calendar.ts";
import { OAuthError } from "../google/oauth.ts";
import {
  type CalendarProvider,
  type EventChanges,
  type EventWrite,
  type ExternalChange,
  type ProviderCalendar,
  ProviderError,
  type ProviderEvent,
  type ResponseStatus,
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
    rsvpNote: self?.comment ?? "",
    attendeeCount: e.attendees?.filter((a) => !a.resource).length ?? 0,
    attendees: (e.attendees ?? [])
      .filter((a) => !a.resource && a.email)
      .map((a) => (a.email ?? "").toLowerCase()),
    organizerSelf: e.organizer?.self !== false,
    recurringId: e.recurringEventId ?? null,
    colorId: e.colorId ?? null,
    updated: e.updated ? Date.parse(e.updated) : null,
    privateProps: e.extendedProperties?.private ?? {},
    responses: Object.fromEntries(
      (e.attendees ?? [])
        .filter((a) => !a.resource && a.email && a.responseStatus)
        .map((a) => [(a.email ?? "").toLowerCase(), a.responseStatus as ResponseStatus]),
    ),
    conference: e.hangoutLink ?? "",
    alerts: e.reminders?.useDefault === true || (e.reminders?.overrides?.length ?? 0) > 0,
    visibility: e.visibility ?? "default",
  };
}

/**
 * Calendars that Google makes, such as national holidays and birthdays, are
 * not offered (accounts-connected-calendars.md rules 4, 5).
 */
export const providerMade = (id: string) => id.endsWith("@group.v.calendar.google.com");

function toGoogleReminders(r: EventWrite["reminders"]): NonNullable<GoogleEventInput["reminders"]> {
  return !r
    ? { useDefault: false }
    : "useDefault" in r
      ? { useDefault: true }
      : {
          useDefault: false,
          overrides: r.minutes.map((minutes) => ({ method: "popup", minutes })),
        };
}

function toGoogleEvent(w: EventWrite): GoogleEventInput {
  return {
    summary: w.summary,
    description: w.description,
    start: w.allDayDates
      ? { date: w.allDayDates.start }
      : { dateTime: new Date(w.start).toISOString() },
    end: w.allDayDates ? { date: w.allDayDates.end } : { dateTime: new Date(w.end).toISOString() },
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
    reminders: toGoogleReminders(w.reminders),
    ...(w.visibility ? { visibility: w.visibility } : {}),
    extendedProperties: { private: w.privateProps },
    ...(w.recurrence ? { recurrence: [`RRULE:${w.recurrence}`] } : {}),
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
  // A revoked refresh token or an account that needs a new login is a
  // rejected login of this account only (accounts-login-emails-permissions.md rule 16).
  if (err instanceof OAuthError && (err.code === "invalid_grant" || err.code === "reauth_required"))
    throw new ProviderError("auth", 401, err.message);
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
    return list
      .filter((c) => !providerMade(c.id))
      .map((c) => ({
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

  /** editExternal sends no update to guests (sendUpdates "none"), except with an answer. */
  async notifiesGuests(): Promise<boolean> {
    return false;
  }

  async editExternal(
    calendarId: string,
    eventId: string,
    change: ExternalChange,
    etag: string | null,
  ): Promise<ProviderEvent> {
    const patch: Partial<GoogleEventInput> = {};
    if (change.summary !== undefined) patch.summary = change.summary;
    if (change.description !== undefined) patch.description = change.description;
    if (change.location !== undefined) patch.location = change.location;
    if (change.busy !== undefined) patch.transparency = change.busy ? "opaque" : "transparent";
    if (change.visibility !== undefined) patch.visibility = change.visibility;
    if (change.colorId !== undefined) patch.colorId = change.colorId ?? "";
    if (change.reminders !== undefined) patch.reminders = toGoogleReminders(change.reminders);
    if (change.end !== undefined) patch.end = { dateTime: new Date(change.end).toISOString() };
    if (change.start !== undefined)
      patch.start = { dateTime: new Date(change.start).toISOString() };
    const answer = change.selfResponse;
    const retimed = change.start !== undefined || change.end !== undefined;
    if (answer || change.guests || retimed) {
      const current = await this.#api.getEvent(calendarId, eventId).catch(mapError);
      const moved =
        retimed &&
        ((change.start !== undefined &&
          Date.parse(current.start?.dateTime ?? "") !== change.start) ||
          (change.end !== undefined && Date.parse(current.end?.dateTime ?? "") !== change.end));
      if (answer || change.guests || (moved && current.attendees?.length)) {
        const gone = new Set(change.guests?.remove.map((e) => e.toLowerCase()));
        const role = new Map(change.guests?.add.map((g) => [g.email.toLowerCase(), g.optional]));
        const list = (current.attendees ?? [])
          .filter((a) => !gone.has(a.email.toLowerCase()))
          .map((a) => {
            const email = a.email.toLowerCase();
            const optional = role.get(email);
            role.delete(email);
            return {
              ...a,
              ...(optional !== undefined ? { optional } : {}),
              // A new time asks the guests again.
              ...(moved && !a.self ? { responseStatus: "needsAction" as const } : {}),
              ...(a.self && answer
                ? {
                    responseStatus: answer,
                    ...(change.comment !== undefined ? { comment: change.comment } : {}),
                  }
                : {}),
            };
          });
        for (const [email, optional] of role) list.push({ email, optional });
        patch.attendees = list;
      }
    }
    // The organizer hears about a changed answer; nobody hears about other edits.
    const ev = await this.#api
      .patchEvent(calendarId, eventId, patch, {
        ...(etag && !change.selfResponse ? { etag } : {}),
        sendUpdates: change.selfResponse ? "all" : "none",
      })
      .catch(mapError);
    return fromGoogleEvent(ev, this.#zone);
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    await this.#api.deleteEvent(calendarId, eventId).catch(mapError);
  }

  async setSeriesProps(
    calendarId: string,
    seriesId: string,
    props: Record<string, string>,
  ): Promise<void> {
    await this.#api
      .patchEvent(calendarId, seriesId, { extendedProperties: { private: props } })
      .catch(mapError);
  }
}
