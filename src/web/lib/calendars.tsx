// The user's calendars, shared by the connected-calendar list and the
// mirroring form on the Settings page.
import { signal } from "@preact/signals";
import { waitingNote } from "../../shared/event-settings.ts";
import { ApiError, api } from "./api.ts";

export interface CalendarRow {
  id: string;
  name: string;
  is_primary: number;
  writable: number;
  check_availability: number;
  category: "business" | "personal" | "travel";
  provider: string;
  email: string;
  account_id: string;
  /** The main calendar: the primary calendar of the main email. */
  main: number;
  /** Always connected: the main calendar, or used by an enabled mirroring policy. */
  locked: number;
  /** Someone shared it with the account; it was added by URL. */
  shared: number;
}

export const calendarList = signal<CalendarRow[]>([]);

export async function loadCalendars(): Promise<void> {
  calendarList.value = (await api<{ calendars: CalendarRow[] }>("GET", "/api/calendars")).calendars;
}

/** The calendar's name, with its account's email when another calendar has the same name. */
export function displayName(c: CalendarRow, all: CalendarRow[]): string {
  const twins = all.filter((o) => o.provider !== "ics" && o.name === c.name).length;
  return twins > 1 ? `${c.name} (${c.email})` : c.name;
}

/** The server's message for a failed action. */
export const failure = (err: unknown) =>
  (err instanceof ApiError && (err.body as { message?: string } | undefined)?.message) ||
  "That did not work. Try again.";

export interface Ask {
  title: string;
  text: string;
  action: string;
  onYes: () => void;
}

/** A confirmation dialog. */
export function Confirm({ ask, onClose }: { ask: Ask; onClose: () => void }) {
  return (
    <div class="dialog-backdrop">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <h2 id="confirm-title">{ask.title}</h2>
        <p>{ask.text}</p>
        <div class="actions">
          <button
            type="button"
            class="primary"
            onClick={() => {
              onClose();
              ask.onYes();
            }}
          >
            {ask.action}
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Accounts rule 16: the item writes to a calendar of a disconnected account,
 * so it gets no new events until the user reconnects that account.
 */
export function CalendarDisconnected({ email }: { email: string | null | undefined }) {
  if (!email) return null;
  return (
    <div class="status error" role="alert" data-testid="calendar-disconnected">
      {waitingNote(email)}
    </div>
  );
}
