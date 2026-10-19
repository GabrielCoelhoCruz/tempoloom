// The Google E2E driver's test calendar guard (src/server/google/test-calendar.ts),
// against a fake Google calendar list.
//
// Ways it can fail:
// 1. A calendar with the test name and marker that another account created and
//    shared with "manage sharing" (accessRole "owner") is picked and emptied.
// 2. A calendar without the marker, or with no dataOwner, is picked.
// 3. A second marked calendar is ignored, so two runs use different calendars.
// 4. A new calendar is found again by listing (which can lag) instead of
//    taking the id that the create call returns.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GoogleCalendarApi,
  type GoogleCalendarListEntry,
} from "../../src/server/google/calendar.ts";
import { ownTestCalendar } from "../../src/server/google/test-calendar.ts";

const OWNER = "Tester@Example.com";
const SPEC = {
  summary: "[tl-test] tempoloom-e2e",
  marker: "tempoloom-e2e: made by the E2E driver",
  owner: OWNER,
  timeZone: "Europe/Berlin",
};
const own: GoogleCalendarListEntry = {
  id: "own@group.calendar.google.com",
  summary: SPEC.summary,
  description: SPEC.marker,
  accessRole: "owner",
  dataOwner: "tester@example.com",
};
const sharedIn: GoogleCalendarListEntry = {
  ...own,
  id: "shared@group.calendar.google.com",
  dataOwner: "someone-else@example.com",
};

let listed: GoogleCalendarListEntry[];
let requests: string[];
const api = new GoogleCalendarApi({ getAccessToken: async () => "access-1" });

beforeEach(() => {
  requests = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url.pathname}`);
    if (url.pathname === "/calendar/v3/users/me/calendarList")
      return Response.json({ items: listed });
    if (method === "POST" && url.pathname === "/calendar/v3/calendars") {
      const body = JSON.parse(String(init?.body)) as { summary: string; description?: string };
      return Response.json({ id: "new@group.calendar.google.com", ...body });
    }
    return new Response("not found", { status: 404 });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("ownTestCalendar", () => {
  it("accepts the marked calendar that the account itself created", async () => {
    listed = [{ id: OWNER, summary: OWNER, accessRole: "owner", primary: true }, own];
    expect(await ownTestCalendar(api, SPEC)).toBe(own.id);
    expect(requests).toEqual(["GET /calendar/v3/users/me/calendarList"]);
  });

  it("refuses an owner-role marked calendar that another account created", async () => {
    listed = [sharedIn];
    await expect(ownTestCalendar(api, SPEC)).rejects.toThrow(
      `${sharedIn.id} (owner someone-else@example.com) was not created by ${OWNER}`,
    );
    listed = [own, sharedIn];
    await expect(ownTestCalendar(api, SPEC)).rejects.toThrow(sharedIn.id);
    const { dataOwner: _, ...noOwner } = own;
    listed = [noOwner];
    await expect(ownTestCalendar(api, SPEC)).rejects.toThrow("(owner unknown)");
    expect(requests.filter((r) => !r.startsWith("GET "))).toEqual([]);
  });

  it("creates the calendar when only unmarked calendars have the name", async () => {
    const { description: _, ...unmarked } = own;
    listed = [{ ...unmarked, id: "hand-made@group.calendar.google.com" }];
    expect(await ownTestCalendar(api, SPEC)).toBe("new@group.calendar.google.com");
    expect(requests).toEqual([
      "GET /calendar/v3/users/me/calendarList",
      "POST /calendar/v3/calendars",
    ]);
  });

  it("stops and names both ids when the account has two marked calendars", async () => {
    listed = [own, { ...own, id: "two@group.calendar.google.com" }];
    await expect(ownTestCalendar(api, SPEC)).rejects.toThrow(
      `found ${own.id}, two@group.calendar.google.com`,
    );
  });
});
