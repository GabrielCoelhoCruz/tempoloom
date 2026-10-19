// The Google E2E driver's own test calendar (tests/e2e/fixtures.ts). The driver
// deletes every event in it, so it must never pick a calendar that the account
// did not create: accessRole "owner" also covers a calendar that another
// account shares with "make changes and manage sharing".
import type { GoogleCalendarApi, GoogleCalendarListEntry } from "./calendar.ts";

export interface TestCalendarSpec {
  summary: string;
  /** Description that the driver sets when it creates the calendar. */
  marker: string;
  /** Email of the authenticated account (Google user or service account). */
  owner: string;
  timeZone: string;
}

/**
 * Returns the id of the account's own marked test calendar, and creates it
 * when there is none. Stops when a calendar with the name and marker belongs
 * to another account, or when the account has more than one.
 */
export async function ownTestCalendar(
  api: Pick<GoogleCalendarApi, "listCalendars" | "createCalendar">,
  spec: TestCalendarSpec,
): Promise<string> {
  const owner = spec.owner.toLowerCase();
  const marked = (await api.listCalendars()).filter(
    (c) => c.summary === spec.summary && c.description === spec.marker,
  );
  const foreign = marked.filter((c) => !createdBy(c, owner));
  if (foreign.length)
    throw new Error(
      `Test calendar ${foreign.map((c) => `${c.id} (owner ${c.dataOwner ?? "unknown"})`).join(", ")} was not created by ${spec.owner}; stopped`,
    );
  if (marked.length > 1)
    throw new Error(
      `Expected one test calendar "${spec.summary}", found ${marked.map((c) => c.id).join(", ")}; delete the extra ones`,
    );
  if (marked[0]) return marked[0].id;
  return (await api.createCalendar(spec.summary, spec.timeZone, spec.marker)).id;
}

/** Google sets dataOwner on secondary calendars to the email of the account that owns it. */
function createdBy(c: GoogleCalendarListEntry, owner: string): boolean {
  return c.accessRole === "owner" && c.dataOwner?.toLowerCase() === owner;
}
