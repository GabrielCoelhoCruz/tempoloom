// The MCP server (docs/specs/assistant-mcp-server.md): any MCP client reads the
// schedule with a personal API key; its writes are staged in preview mode
// (docs/specs/assistant-preview-mode.md) until the user applies them in the planner.
//
// Ways this can fail, each covered below:
// - a client without a valid key reads data, or the protocol shape breaks generic clients;
// - read tools disagree with the calendar (titles, times, guests), or free time
//   overlaps a busy event or leaves the meeting hours;
// - a propose tool writes to the calendar at once, or stages an edit of a meeting
//   the user does not organize;
// - a staged change does not show in the planner, or is lost on reload;
// - apply writes the wrong thing, or leaves the change staged;
// - a discarded change, or one removed from the final list, still reaches the calendar;
// - attendees hear about a change before apply, or not at all after apply;
// - a change whose target moved after staging overwrites the newer state;
// - a read-only server lists or runs write tools, or stages something.
import { addDays, utcToLocal } from "../../src/shared/time.ts";
import { createKey } from "./delegation-helpers.ts";
import {
  at,
  BASE_URL,
  type CalendarDriver,
  COLLEAGUE_EMAIL,
  eventually,
  expect,
  local,
  planNow,
  test,
  ZONE,
} from "./fixtures.ts";
import { MIN, W } from "./helpers.ts";
import { connect, iso, previewPanel, reviewAndApply, stagedRow } from "./preview-helpers.ts";

const tue = addDays(W, 1);
const wed = addDays(W, 2);
const weekEvents = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(addDays(W, 7), "00:00"));
const named = <T extends { summary: string }>(evs: T[], title: string) =>
  evs.filter((e) => e.summary === title);

interface ListedEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  attendees: string[];
}

test("an MCP client with an API key reads the schedule, free time, the week summary and meeting context (SPEC-ASSIST-03 rules 1-3, T1, T2)", async ({
  page,
  cal,
  signIn,
  request,
}) => {
  await cal.addEvent({
    title: "Design review",
    start: at(tue, "10:00"),
    end: at(tue, "11:00"),
    attendees: [COLLEAGUE_EMAIL],
  });
  await cal.addEvent({ title: "Lunch and learn", start: at(tue, "14:00"), end: at(tue, "15:00") });
  // A past meeting with the same guest, for meeting preparation.
  const past = addDays(utcToLocal(ZONE, Date.now()).date, -7);
  await cal.addEvent({
    title: "Design sync",
    start: at(past, "10:00"),
    end: at(past, "10:30"),
    attendees: [COLLEAGUE_EMAIL],
  });
  await signIn();
  const key = await createKey(page, "Claude");
  await expect(page.getByTestId("mcp-section")).toContainText(`${BASE_URL}/mcp`);
  await expect(page.getByTestId("mcp-section")).toContainText("stage changes");

  // Without a key, or with a wrong one, the server answers 401 and reads nothing.
  for (const authorization of [undefined, "Bearer tl-wrong-key"]) {
    const res = await request.post("/mcp", {
      headers: {
        accept: "application/json, text/event-stream",
        ...(authorization ? { authorization } : {}),
      },
      data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(res.status()).toBe(401);
    expect(res.headers()["www-authenticate"]).toContain("Bearer");
  }

  const mcp = await connect(request, key);
  expect(await mcp.toolNames()).toEqual(
    expect.arrayContaining([
      "list_events",
      "find_free_time",
      "get_week_summary",
      "get_meeting_context",
      "list_tasks",
      "list_automations",
      "list_staged_changes",
      "propose_create_event",
      "propose_update_event",
      "propose_delete_event",
      "apply_staged_changes",
    ]),
  );
  // An unknown method is a JSON-RPC error, not an HTTP error.
  expect((await mcp.raw("calendar/explode")).error?.code).toBe(-32601);

  // T1: Tuesday's events, as on the calendar.
  const day = { start: iso(at(tue, "00:00")), end: iso(at(addDays(tue, 1), "00:00")) };
  const { events } = await eventually(
    () => mcp.tool<{ events: ListedEvent[] }>("list_events", day),
    (r) => expect(r.events.map((e) => e.title)).toEqual(["Design review", "Lunch and learn"]),
  );
  const [review, lunch] = events as [ListedEvent, ListedEvent];
  expect(Date.parse(review.start)).toBe(at(tue, "10:00"));
  expect(Date.parse(review.end)).toBe(at(tue, "11:00"));
  expect(review.attendees).toContain(COLLEAGUE_EMAIL);
  expect(Date.parse(lunch.start)).toBe(at(tue, "14:00"));
  // Edge case 3: more than 31 days in one call is refused with the limit.
  const tooLong = await mcp.toolResult("list_events", {
    start: day.start,
    end: iso(at(addDays(tue, 40), "00:00")),
  });
  expect(tooLong.isError).toBe(true);
  expect(tooLong.content[0]?.text).toContain("31 days");

  // T2: every free hour lies in the meeting hours and overlaps neither event.
  const { slots } = await mcp.tool<{ slots: { start: string; end: string }[] }>("find_free_time", {
    duration_minutes: 60,
    ...day,
  });
  expect(slots.length).toBeGreaterThan(0);
  expect(Date.parse(slots[0]?.start ?? "")).toBe(at(tue, "09:00"));
  for (const s of slots) {
    const [a, b] = [Date.parse(s.start), Date.parse(s.end)];
    expect(b - a).toBe(60 * MIN);
    expect(local(a) >= `${tue} 09:00` && local(b) <= `${tue} 17:00`).toBe(true);
    for (const [x, y] of [
      [at(tue, "10:00"), at(tue, "11:00")],
      [at(tue, "14:00"), at(tue, "15:00")],
    ] as const)
      expect(a < y && b > x, `${local(a)} overlaps a meeting`).toBe(false);
  }

  // Week summary: the meeting with a guest counts as meeting time, the other event as other time.
  const week = await mcp.tool<{
    days: { date: string; meeting_hours: number; other_hours: number }[];
  }>("get_week_summary", { week_start: W });
  expect(week.days).toHaveLength(7);
  expect(week.days.find((d) => d.date === tue)).toMatchObject({ meeting_hours: 1, other_hours: 1 });
  expect(week.days.find((d) => d.date === wed)).toMatchObject({ meeting_hours: 0 });

  // Meeting preparation: the guest and the earlier meeting with the same guest.
  const prep = await mcp.tool<{
    event: { title: string; attendees: string[] };
    past_meetings: { title: string }[];
  }>("get_meeting_context", { event_id: review.id });
  expect(prep.event.title).toBe("Design review");
  expect(prep.event.attendees).toContain(COLLEAGUE_EMAIL);
  expect(prep.past_meetings.map((m) => m.title)).toEqual(["Design sync"]);

  // Reading changed nothing on the calendar; the key shows its last use (rule 10).
  expect((await weekEvents(cal)).map((e) => e.summary).sort()).toEqual([
    "Design review",
    "Lunch and learn",
  ]);
  await page.reload();
  await expect(page.locator('[data-key="Claude"]')).toContainText("last used");
});

test("a write from an MCP client is staged, not written; the user accepts and applies it in the planner (SPEC-ASSIST-03 T3, T4; SPEC-ASSIST-02 rules 1, 4-8)", async ({
  page,
  cal,
  signIn,
  request,
}) => {
  await cal.addInvite({
    title: "Board meeting",
    start: at(wed, "10:00"),
    end: at(wed, "11:00"),
    answer: "ACCEPTED",
  });
  await signIn();
  const mcp = await connect(request, await createKey(page, "Claude"));

  const staged = await mcp.tool<{ id: string; state: string; review_url: string }>(
    "propose_create_event",
    {
      title: "Write report",
      start: iso(at(tue, "15:30")),
      end: iso(at(tue, "16:30")),
      reason: "You asked for two hours of writing this week.",
    },
  );
  expect(staged.state).toBe("pending");
  expect(staged.review_url).toBe(`${BASE_URL}/?week=${W}`);
  // Edge case 2: an event someone else organizes cannot be changed; nothing is staged.
  const { events } = await eventually(
    () =>
      mcp.tool<{ events: ListedEvent[] }>("list_events", {
        start: iso(at(wed, "00:00")),
        end: iso(at(addDays(wed, 1), "00:00")),
      }),
    (r) => expect(r.events.map((e) => e.title)).toEqual(["Board meeting"]),
  );
  const refused = await mcp.toolResult("propose_update_event", {
    event_id: events[0]?.id,
    start: iso(at(wed, "12:00")),
    end: iso(at(wed, "13:00")),
  });
  expect(refused.isError).toBe(true);
  expect(refused.content[0]?.text).toContain("organize");
  const listed = await mcp.tool<{ changes: { id: string; source: string }[] }>(
    "list_staged_changes",
  );
  expect(listed.changes).toEqual([
    expect.objectContaining({ id: staged.id, source: "mcp_client" }),
  ]);

  // Nothing reached the calendar.
  await planNow(page);
  expect(named(await weekEvents(cal), "Write report")).toHaveLength(0);

  // The planner shows the staged event, marked, with its source and reason.
  await page.goto(staged.review_url);
  await expect(previewPanel(page).getByLabel("Preview mode")).toBeChecked();
  await expect(page.locator(".ev-staged-new", { hasText: "Write report" })).toBeVisible();
  const row = stagedRow(page, "Write report");
  await expect(row).toContainText("AI tool (Claude)");
  await expect(row).toContainText("two hours of writing");
  await expect(row).toContainText("Pending");
  await page.reload();
  await expect(page.locator(".ev-staged-new", { hasText: "Write report" })).toBeVisible();
  await row.getByRole("button", { name: "Accept" }).click();
  await expect(row).toContainText("Accepted");

  await reviewAndApply(page);
  await expect(page.getByTestId("apply-summary")).toContainText("Applied 1");
  const [report] = named(
    await eventually(
      () => weekEvents(cal),
      (evs) => expect(named(evs, "Write report")).toHaveLength(1),
    ),
    "Write report",
  );
  expect(local(report?.start ?? 0)).toBe(`${tue} 15:30`);
  expect(local(report?.end ?? 0)).toBe(`${tue} 16:30`);

  // After reload nothing is staged, and preview mode went off with nothing left to review.
  await page.reload();
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(0);
  await expect(previewPanel(page).getByLabel("Preview mode")).not.toBeChecked();
  await expect(page.locator(".ev", { hasText: "Write report" })).toBeVisible();
  expect((await mcp.tool<{ changes: unknown[] }>("list_staged_changes")).changes).toEqual([]);
});

test("the final list applies only what stays in it; attendees hear only at apply (SPEC-ASSIST-02 rules 6-9, T3)", async ({
  page,
  cal,
  signIn,
  request,
  mail,
}) => {
  await cal.addEvent({
    title: "Design review",
    start: at(tue, "10:00"),
    end: at(tue, "11:00"),
    attendees: [COLLEAGUE_EMAIL],
  });
  await signIn();
  const mcp = await connect(request, await createKey(page, "Claude"));
  const { events } = await eventually(
    () =>
      mcp.tool<{ events: ListedEvent[] }>("list_events", {
        start: iso(at(tue, "00:00")),
        end: iso(at(addDays(tue, 1), "00:00")),
      }),
    (r) => expect(r.events.map((e) => e.title)).toEqual(["Design review"]),
  );
  const guest = "guest@example.org";
  await mcp.tool("propose_create_event", {
    title: "Kickoff",
    start: iso(at(wed, "09:00")),
    end: iso(at(wed, "09:30")),
    attendees: [guest],
  });
  await mcp.tool("propose_create_event", {
    title: "Draft plan",
    start: iso(at(wed, "15:00")),
    end: iso(at(wed, "16:00")),
  });
  await mcp.tool("propose_create_event", {
    title: "Old idea",
    start: iso(at(wed, "11:00")),
    end: iso(at(wed, "12:00")),
  });
  await mcp.tool("propose_update_event", {
    event_id: events[0]?.id,
    start: iso(at(tue, "16:00")),
    end: iso(at(tue, "17:00")),
    reason: "The morning is free for focus.",
  });

  await page.goto(`/?week=${W}`);
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(4);
  // The move shows at its new time; the event stays at its old time until apply.
  await expect(page.locator(".ev-staged-new", { hasText: "Design review" })).toBeVisible();
  await expect(page.locator(".ev-staged-from", { hasText: "Design review" })).toBeVisible();
  // Discard one: the others stay.
  await stagedRow(page, "Old idea").getByRole("button", { name: "Discard" }).click();
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(3);
  await expect(page.locator(".ev-staged-new", { hasText: "Old idea" })).toHaveCount(0);

  // Staging notified no one.
  await planNow(page);
  expect(await mail.count(guest)).toBe(0);
  expect(await mail.count(COLLEAGUE_EMAIL)).toBe(0);
  const before = await weekEvents(cal);
  expect(named(before, "Kickoff")).toHaveLength(0);
  expect(local((named(before, "Design review")[0] as { start: number }).start)).toBe(
    `${tue} 10:00`,
  );

  // The final list holds the three; removing one keeps it off the calendar.
  await reviewAndApply(page, ["Draft plan"]);
  await expect(page.getByTestId("apply-summary")).toContainText("Applied 2");
  const after = await eventually(
    () => weekEvents(cal),
    (evs) => {
      expect(named(evs, "Kickoff")).toHaveLength(1);
      expect(local((named(evs, "Design review")[0] as { start: number }).start)).toBe(
        `${tue} 16:00`,
      );
    },
  );
  expect(named(after, "Draft plan")).toHaveLength(0);
  expect(named(after, "Old idea")).toHaveLength(0);
  const kickoff = named(after, "Kickoff")[0] as { id: string; start: number };
  expect(local(kickoff.start)).toBe(`${wed} 09:00`);
  expect((await cal.guests(kickoff.id)).map((g) => g.email)).toContain(guest);

  // Apply sends one message to each attendee.
  const invite = await mail.message(guest, /Kickoff/);
  expect(invite.subject).toContain("Invitation");
  expect(invite.text).toContain("09:00");
  const update = await mail.message(COLLEAGUE_EMAIL, /Design review/);
  expect(update.subject).toContain("Updated");
  expect(update.text).toContain("16:00");
  expect(await mail.count(guest)).toBe(1);
  expect(await mail.count(COLLEAGUE_EMAIL)).toBe(1);

  await page.reload();
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(0);
  expect(named(await weekEvents(cal), "Draft plan")).toHaveLength(0);
});

test("a staged change whose event moved after staging is skipped as stale (SPEC-ASSIST-02 rule 12, T5)", async ({
  page,
  cal,
  signIn,
  request,
}) => {
  const id = await cal.addEvent({
    title: "Lunch and learn",
    start: at(tue, "14:00"),
    end: at(tue, "15:00"),
  });
  await signIn();
  const mcp = await connect(request, await createKey(page, "Claude"));
  const range = { start: iso(at(tue, "00:00")), end: iso(at(addDays(tue, 1), "00:00")) };
  const { events } = await eventually(
    () => mcp.tool<{ events: ListedEvent[] }>("list_events", range),
    (r) => expect(r.events.map((e) => e.title)).toEqual(["Lunch and learn"]),
  );
  await mcp.tool("propose_update_event", {
    event_id: events[0]?.id,
    start: iso(at(tue, "16:00")),
    end: iso(at(tue, "17:00")),
  });
  // The user moves the event in their calendar app before applying.
  await cal.update(id, { start: at(tue, "17:00"), end: at(tue, "18:00") });
  await eventually(
    () => mcp.tool<{ events: ListedEvent[] }>("list_events", range),
    (r) => expect(Date.parse(r.events[0]?.start ?? "")).toBe(at(tue, "17:00")),
  );

  await page.goto(`/?week=${W}`);
  await reviewAndApply(page);
  const summary = page.getByTestId("apply-summary");
  await expect(summary).toContainText("Applied 0");
  await expect(summary).toContainText("Skipped as stale 1");
  await expect(summary).toContainText("Lunch and learn");
  await expect(summary).toContainText("changed after it was staged");
  await planNow(page);
  const [lunch] = named(await weekEvents(cal), "Lunch and learn") as { start: number }[];
  expect(local(lunch?.start ?? 0)).toBe(`${tue} 17:00`);
  await page.reload();
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(0);
});

test("a read-only server lists no write tools, refuses a write and stages nothing (SPEC-ASSIST-03 rule 9, T5; SPEC-PLANS-01 T3)", async ({
  page,
  app,
  cal,
  signIn,
  request,
}) => {
  app.env.MCP_WRITE_ENABLED = "false";
  await app.restart();
  await cal.addEvent({ title: "Lunch and learn", start: at(tue, "14:00"), end: at(tue, "15:00") });
  await signIn();
  const key = await createKey(page, "Claude");
  const section = page.getByTestId("mcp-section");
  await expect(section).toContainText("read-only");
  await expect(section).not.toContainText("stage changes");
  const mcp = await connect(request, key);
  const names = await mcp.toolNames();
  expect(names).toContain("list_events");
  expect(names.filter((n) => n.startsWith("propose_") || n === "apply_staged_changes")).toEqual([]);
  const write = await mcp.raw("tools/call", {
    name: "propose_create_event",
    arguments: {
      title: "Write report",
      start: iso(at(tue, "15:30")),
      end: iso(at(tue, "16:30")),
    },
  });
  expect(write.error?.code).toBe(-32602);
  expect(write.error?.message).toContain("read-only");
  // Reads still work.
  await eventually(
    () =>
      mcp.tool<{ events: ListedEvent[] }>("list_events", {
        start: iso(at(tue, "00:00")),
        end: iso(at(addDays(tue, 1), "00:00")),
      }),
    (r) => expect(r.events.map((e) => e.title)).toEqual(["Lunch and learn"]),
  );
  await planNow(page);
  expect(named(await weekEvents(cal), "Write report")).toHaveLength(0);
  await page.goto(`/?week=${W}`);
  await expect(previewPanel(page)).toBeVisible();
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(0);
  await expect(page.locator(".ev-staged-new")).toHaveCount(0);
  await page.reload();
  await expect(previewPanel(page).getByLabel("Preview mode")).not.toBeChecked();
  await expect(page.getByTestId("preview-pending")).toHaveCount(0);
});
