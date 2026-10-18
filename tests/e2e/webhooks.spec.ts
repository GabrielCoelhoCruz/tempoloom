// Outgoing webhooks for booking links (docs/specs/integrations-webhooks.md).
// A local HTTP receiver logs each request; the test checks type, signature,
// payload and retries. Endpoints live in Team settings > Webhooks (admins
// only); members attach them to their own links on the Booking links page.
//
// Ways the endpoint management can fail (rules 1-6, acceptance test 6):
//  1. A member sees the "+ New" button, or the API lets a member create,
//     regenerate, resume or delete an endpoint.
//  2. A member cannot attach a team endpoint to their own link, or the request
//     for that link is not sent.
//  3. An endpoint of another team can be attached.
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import { at, blockUntil, eventually, expect, local, test } from "./fixtures.ts";
import { addLink, allEvents, book, claimPage, slot, visitor, W } from "./helpers.ts";
import { teamOf } from "./link-helpers.ts";
import { openTeam } from "./team-helpers.ts";

const day = (n: number) => addDays(W, n);

interface Received {
  at: number;
  headers: Record<string, string | string[] | undefined>;
  raw: string;
  body: Record<string, unknown> & { request_id: string; type: string };
}

type Answer = number | { status: number; retryAfter: string };

/** A receiver on loopback. `answers` are given in order, then 200. */
async function receiver(answers: Answer[] = []) {
  const log: Received[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (b: Buffer) => {
      raw += b.toString();
    });
    req.on("end", () => {
      log.push({
        at: Date.now(),
        headers: req.headers,
        raw,
        body: JSON.parse(raw) as Received["body"],
      });
      const a = answers.shift() ?? 200;
      if (typeof a === "number") res.statusCode = a;
      else {
        res.statusCode = a.status;
        res.setHeader("retry-after", a.retryAfter);
      }
      res.end();
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    log,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

const signed = (r: Received, secret: string) =>
  r.headers["x-tempoloom-signature-256"] ===
  `sha256=${createHmac("sha256", secret).update(r.raw).digest("base64")}`;

/** Opens Team settings > Webhooks and the "+ New" form. */
async function newWebhookForm(page: Page) {
  await openTeam(page);
  const form = page.getByTestId("webhook-form");
  if (!(await form.isVisible())) await page.getByRole("button", { name: "+ New" }).click();
  return form;
}

async function addWebhook(page: Page, name: string, url: string, secret = ""): Promise<string> {
  const form = await newWebhookForm(page);
  await form.getByLabel("Name").fill(name);
  await form.getByLabel("URL").fill(url);
  if (secret) await form.getByLabel(/Secret/).fill(secret);
  await form.getByRole("button", { name: "Add webhook" }).click();
  await expect(page.getByTestId("webhook-secret-box")).toContainText(`Secret for ${name}`);
  return (await page.getByTestId("webhook-secret").textContent()) ?? "";
}

const linkBox = (page: Page, linkTitle: string, endpoint: string) =>
  page
    .locator(`[data-link-title="${linkTitle}"]`)
    .getByTestId("link-webhooks")
    .getByLabel(endpoint);

async function attach(page: Page, linkTitle: string, endpoint: string) {
  await page.getByRole("link", { name: "Booking links" }).click();
  await linkBox(page, linkTitle, endpoint).check();
  await expect(linkBox(page, linkTitle, endpoint)).toBeChecked();
}

test("booking, reschedule and cancel send signed requests with custom data; a new secret signs the next one (rules 2-7, 16-18, 23)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  const hook = await receiver();
  try {
    await blockUntil(cal, W);
    await signIn();
    await claimPage(page, "hana");
    await addLink(page, { title: "Intro", durations: "30" });
    await addLink(page, { title: "Other", durations: "30" });

    // URL validation: a public host needs https; nothing is saved.
    const form = await newWebhookForm(page);
    await form.getByLabel("Name").fill("CRM");
    await form.getByLabel("URL").fill("http://example.com/hook");
    await form.getByRole("button", { name: "Add webhook" }).click();
    await expect(page.getByTestId("webhook-url-error")).toHaveText("Use https");
    await page.reload();
    await expect(page.getByTestId("webhook-list")).toContainText("No webhooks yet.");

    const secret = await addWebhook(page, "CRM", hook.url);
    expect(secret.length).toBeGreaterThanOrEqual(32);
    await attach(page, "Intro", "CRM");
    // The secret is shown once.
    await openTeam(page);
    await page.reload();
    await expect(page.getByTestId("webhook-secret-box")).toHaveCount(0);
    await expect(page.getByTestId("webhook-row")).toContainText("1 links");

    // A link without the endpoint sends nothing (rule 5).
    const v = await visitor(browser);
    await v.goto("/book/hana/other");
    await book(v, at(day(1), "09:00"), "Ivo", "ivo@example.com");

    await v.goto("/book/hana/intro?data-source=ad1&utm_medium=mail");
    await book(v, at(W, "11:00"), "Gus", "gus@example.com");
    const created = await eventually(
      async () => hook.log,
      (l) => expect(l).toHaveLength(1),
    );
    const [c] = created;
    if (!c) throw new Error("no request");
    expect(c.headers["x-tempoloom-webhook-type"]).toBe("booking_link.meeting.created");
    expect(c.headers["x-tempoloom-api-version"]).toBe("v2026-10-01");
    expect(c.headers["content-type"]).toBe("application/json");
    expect(signed(c, secret)).toBe(true);
    const meeting = c.body.meeting as Record<string, unknown>;
    expect(c.body.type).toBe("booking_link.meeting.created");
    expect(meeting.custom_data).toEqual({ data: { source: "ad1" }, errors: [] });
    expect(meeting.attendee).toEqual({ email: "gus@example.com", name: "Gus" });
    expect(meeting.booking_link_title).toBe("Intro");
    // The payload times match the calendar event.
    const events = await allEvents(cal);
    const ev = events.find((e) => e.summary.includes("Gus"));
    expect(ev).toBeDefined();
    expect(meeting.start_time).toBe(new Date(ev?.start ?? 0).toISOString());
    expect(meeting.end_time).toBe(new Date(ev?.end ?? 0).toISOString());

    // A new secret signs the next request (rule 3).
    await openTeam(page);
    await page.getByTestId("webhook-row").getByRole("button", { name: "New secret" }).click();
    const secret2 = (await page.getByTestId("webhook-secret").textContent()) ?? "";
    expect(secret2).not.toBe(secret);

    await v.getByTestId("manage-link").click();
    await v.getByRole("button", { name: "Reschedule" }).click();
    await slot(v, at(day(1), "14:00")).click();
    await expect(v.getByText("Your booking has a new time.")).toBeVisible();
    const updated = await eventually(
      async () => hook.log,
      (l) => expect(l).toHaveLength(2),
    );
    const u = updated[1] as Received;
    expect(u.body.type).toBe("booking_link.meeting.updated");
    expect(signed(u, secret2)).toBe(true);
    expect(signed(u, secret)).toBe(false);
    expect(u.body.change_reason).toBe("rescheduled");
    const prev = u.body.previous_meeting as Record<string, unknown>;
    const next = u.body.new_meeting as Record<string, unknown>;
    expect(prev.start_time).toBe(new Date(at(W, "11:00")).toISOString());
    expect(next.start_time).toBe(new Date(at(day(1), "14:00")).toISOString());
    expect(next.rescheduled_at).toBeDefined();
    expect(next.custom_data).toEqual({ data: { source: "ad1" }, errors: [] });
    await eventually(
      () => allEvents(cal),
      (l) =>
        expect(local(l.find((e) => e.summary.includes("Gus"))?.start ?? 0)).toBe(`${day(1)} 14:00`),
    );

    await v.getByRole("button", { name: "Cancel booking" }).click();
    await expect(v.getByTestId("booking-status")).toHaveText("Cancelled");
    const all = await eventually(
      async () => hook.log,
      (l) => expect(l).toHaveLength(3),
    );
    const x = all[2] as Received;
    expect(x.body.type).toBe("booking_link.meeting.cancelled");
    expect((x.body.meeting as Record<string, unknown>).cancelled_at).toBeDefined();
    expect(new Set(all.map((r) => r.body.request_id)).size).toBe(3);
    await eventually(
      () => allEvents(cal),
      (l) => expect(l.find((e) => e.summary.includes("Gus"))).toBeUndefined(),
    );
    await openTeam(page);
    await page.reload();
    await expect(page.getByTestId("webhook-row")).toContainText("last result HTTP 200");
  } finally {
    await hook.close();
  }
});

test("a failing receiver gets retries with one request id and Retry-After; too much custom data is dropped; removed and deleted endpoints stop (rules 2, 6, 8-10, 20)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  const hook = await receiver([500, { status: 503, retryAfter: "3" }]);
  const audit = await receiver();
  try {
    await blockUntil(cal, W);
    await signIn();
    await claimPage(page, "jo");
    await addLink(page, { title: "Demo", durations: "30" });
    const typed = "a-typed-secret-with-32-characters-or-more";
    expect(await addWebhook(page, "Sales", hook.url, typed)).toBe(typed);
    await attach(page, "Demo", "Sales");

    const v = await visitor(browser);
    const six = [1, 2, 3, 4, 5, 6].map((n) => `data-k${n}=v${n}`).join("&");
    await v.goto(`/book/jo/demo?${six}`);
    await book(v, at(W, "10:00"), "Lia", "lia@example.com");
    const log = await eventually(
      async () => hook.log,
      (l) => expect(l).toHaveLength(3),
    );
    expect(new Set(log.map((r) => r.body.request_id)).size).toBe(1);
    expect(log.every((r) => signed(r, typed))).toBe(true);
    // The base delay is 0.5 s, then 1 s; Retry-After asks for 3 s instead.
    const gap = (log[2]?.at ?? 0) - (log[1]?.at ?? 0);
    expect(gap).toBeGreaterThanOrEqual(2900);
    const meeting = log[2]?.body.meeting as Record<string, unknown>;
    expect(meeting.custom_data).toEqual({ data: {}, errors: ["TRUNCATED"] });
    // The booking itself succeeded.
    const events = await allEvents(cal);
    expect(events.find((e) => e.summary.includes("Lia"))).toBeDefined();

    // Removing Sales from the link stops its requests; Audit still gets them.
    await addWebhook(page, "Audit", audit.url);
    await attach(page, "Demo", "Audit");
    await page.getByRole("link", { name: "Booking links" }).click();
    await linkBox(page, "Demo", "Sales").uncheck();
    await expect(linkBox(page, "Demo", "Sales")).not.toBeChecked();
    await v.goto("/book/jo/demo");
    await book(v, at(W, "14:00"), "Max", "max@example.com");
    await eventually(
      async () => audit.log,
      (l) => expect(l).toHaveLength(1),
    );
    expect(hook.log).toHaveLength(3);

    // Delete Audit: it leaves the list and the link.
    await openTeam(page);
    await page
      .getByTestId("webhook-row")
      .filter({ hasText: "Audit" })
      .getByRole("button", { name: "Delete" })
      .click();
    await page.reload();
    await expect(page.getByTestId("webhook-row")).toHaveCount(1);
    await expect(page.getByTestId("webhook-row")).toContainText("Sales");
    await expect(page.getByTestId("webhook-row")).toContainText("0 links");
  } finally {
    await hook.close();
    await audit.close();
  }
});

test("only a team admin manages endpoints in Team settings > Webhooks; a member attaches one to their own link (rules 1, 4; acceptance test 6)", async ({
  page,
  browser,
  signIn,
  colleague,
  mail,
}) => {
  const hook = await receiver();
  try {
    await blockUntil(colleague.cal, W);
    const [pc] = await teamOf(page, signIn, [colleague], mail);
    if (!pc) throw new Error("no colleague page");
    await addWebhook(page, "CRM", hook.url);

    // The member sees the endpoint but cannot manage it.
    await openTeam(pc);
    await pc.reload();
    const section = pc.getByTestId("team-webhooks");
    await expect(section.getByTestId("webhook-row")).toContainText("CRM");
    await expect(section.getByRole("button", { name: "+ New" })).toHaveCount(0);
    await expect(section.getByRole("button", { name: "Delete" })).toHaveCount(0);
    const statuses = await pc.evaluate(async (url) => {
      const post = await fetch("/api/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Mine", url }),
      });
      const list = (await (await fetch("/api/webhooks")).json()) as {
        endpoints: { id: string }[];
      };
      const id = list.endpoints[0]?.id ?? "";
      const del = await fetch(`/api/webhooks/${id}`, { method: "DELETE" });
      const secret = await fetch(`/api/webhooks/${id}/secret`, { method: "POST" });
      return [post.status, del.status, secret.status];
    }, hook.url);
    expect(statuses).toEqual([403, 403, 403]);
    await pc.reload();
    await expect(pc.getByTestId("team-webhooks").getByTestId("webhook-row")).toHaveCount(1);
    await expect(pc.getByRole("button", { name: "+ New" })).toHaveCount(0);

    // The member attaches the team endpoint to their own link; a booking sends to it.
    await claimPage(pc, "mia");
    await addLink(pc, { title: "Office hours", durations: "30" });
    await attach(pc, "Office hours", "CRM");
    const v = await visitor(browser);
    await v.goto("/book/mia/office-hours");
    await book(v, at(W, "10:00"), "Ned", "ned@example.com");
    const log = await eventually(
      async () => hook.log,
      (l) => expect(l).toHaveLength(1),
    );
    const meeting = log[0]?.body.meeting as Record<string, unknown> | undefined;
    expect(meeting?.booking_link_title).toBe("Office hours");
    await eventually(
      () => allEvents(colleague.cal),
      (l) => expect(l.find((e) => e.summary.includes("Ned"))).toBeDefined(),
    );
    await openTeam(page);
    await page.reload();
    await expect(page.getByTestId("webhook-row")).toContainText("1 links");
  } finally {
    await hook.close();
  }
});
