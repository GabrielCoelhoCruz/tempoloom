// Webhook URL rules, the 10-second limit, success codes and suspension
// (docs/specs/integrations-webhooks.md fields table, rules 8, 12-15).
// A local receiver answers each request with a chosen status and delay.
//
// Ways it can fail, and the check that catches each:
// - localhost, *.localhost or an IP literal is saved when private receivers
//   are off, or refused when the operator allows them              -> URL rules
// - a slow answer is waited for past 10 seconds, or a fast one is cut  -> gap between tries; 8 s answer
// - a redirect or another 2xx counts as success, or 201/202/204 fails  -> tries per booking
// - an endpoint failing for the whole period is never suspended, keeps
//   getting requests, or no admin is told                              -> suspension
// - Resume does not send the waiting request                           -> request after Resume
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import { at, blockUntil, EMAIL, eventually, expect, test } from "./fixtures.ts";
import { addLink, allEvents, book, claimPage, strayRequest, visitor, W } from "./helpers.ts";
import { openTeam } from "./team-helpers.ts";

const day = (n: number) => addDays(W, n);

interface Received {
  at: number;
  type: string;
  requestId: string;
}

/** A loopback receiver. Each request takes the next answer; then `fallback`. */
async function receiver(answers: { status: number; delayMs?: number }[] = []) {
  const log: Received[] = [];
  const state = { fallback: 200 };
  const server: Server = createServer((req, res) => {
    if (strayRequest(req, res, "POST", "/hook")) return;
    const arrived = Date.now();
    let raw = "";
    req.on("data", (b: Buffer) => {
      raw += b.toString();
    });
    req.on("end", () => {
      const body = JSON.parse(raw) as { type: string; request_id: string };
      log.push({ at: arrived, type: body.type, requestId: body.request_id });
      const a = answers.shift() ?? { status: state.fallback };
      setTimeout(() => {
        res.statusCode = a.status;
        if (a.status === 302) res.setHeader("location", "https://example.com/elsewhere");
        res.end();
      }, a.delayMs ?? 0);
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    log,
    state,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

async function tryWebhook(page: Page, name: string, url: string) {
  await openTeam(page);
  const form = page.getByTestId("webhook-form");
  if (!(await form.isVisible())) await page.getByRole("button", { name: "+ New" }).click();
  await form.getByLabel("Name", { exact: true }).fill(name);
  await form.getByLabel("URL").fill(url);
  await form.getByRole("button", { name: "Add webhook" }).click();
}

async function addWebhook(page: Page, name: string, url: string) {
  await tryWebhook(page, name, url);
  await expect(page.getByTestId("webhook-secret-box")).toContainText(`Secret for ${name}`);
}

async function attach(page: Page, linkTitle: string, endpoint: string) {
  await page.getByRole("link", { name: "Booking links" }).click();
  const box = page
    .locator(`[data-link-title="${linkTitle}"]`)
    .getByTestId("link-webhooks")
    .getByLabel(endpoint);
  const saved = page.waitForResponse((r) => r.url().endsWith("/webhooks") && r.ok());
  await box.check();
  await saved;
  await expect(box).toBeChecked();
}

const row = (page: Page, name: string) => page.getByTestId("webhook-row").filter({ hasText: name });

/** Reloads Team settings until the endpoint's row shows `text` (a delivery is saved after its answer). */
const rowShows = (page: Page, name: string, text: string) =>
  expect
    .poll(
      async () => {
        await page.reload();
        return row(page, name).textContent();
      },
      { timeout: 30_000 },
    )
    .toContain(text);

test("with private receivers off, http, localhost and IP hosts are refused and a public https host is kept; the operator setting allows loopback (fields table, rule 13)", async ({
  page,
  app,
  signIn,
}) => {
  app.env.WEBHOOK_ALLOW_PRIVATE = "0";
  await app.restart();
  await signIn();
  const refused: [string, string][] = [
    ["http://hooks.example.com/crm", "Use https"],
    ["https://localhost/hook", "Use a public host name"],
    ["https://app.localhost/hook", "Use a public host name"],
    ["https://127.0.0.1/hook", "Use a public host name"],
    ["https://[::1]/hook", "Use a public host name"],
    ["https://203.0.113.7/hook", "Use a public host name"],
  ];
  for (const [url, message] of refused) {
    await tryWebhook(page, "CRM", url);
    await expect(page.getByTestId("webhook-url-error")).toHaveText(message);
  }
  await page.reload();
  await expect(page.getByTestId("webhook-list")).toContainText("No webhooks yet.");

  await addWebhook(page, "CRM", "https://hooks.example.com/crm");
  await app.restart();
  await page.reload();
  await expect(page.getByTestId("webhook-row")).toHaveCount(1);
  await expect(row(page, "CRM")).toContainText("https://hooks.example.com/crm");

  // The operator allows private receivers: a loopback receiver may use http.
  app.env.WEBHOOK_ALLOW_PRIVATE = "1";
  await app.restart();
  await page.reload();
  await addWebhook(page, "Local", "http://localhost:9/hook");
  await page.reload();
  await expect(page.getByTestId("webhook-row")).toHaveCount(2);
});

test("an answer after 10 seconds is a failure and is cut at 10 seconds; only 200, 201, 202 and 204 count as success (rules 8, 12, 14)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  const hook = await receiver([
    { status: 200, delayMs: 11_000 },
    { status: 302 },
    { status: 203 },
    { status: 201 },
    { status: 202, delayMs: 8_000 },
    { status: 204 },
  ]);
  try {
    await blockUntil(cal, W);
    await signIn();
    await claimPage(page, "tess");
    await addLink(page, { title: "Intro", durations: "30" });
    await addWebhook(page, "CRM", hook.url);
    await attach(page, "Intro", "CRM");

    const v = await visitor(browser);
    await v.goto("/book/tess/intro");
    await book(v, at(W, "10:00"), "Ada", "ada@example.com");
    const first = await eventually(
      async () => hook.log,
      (l) => expect(l).toHaveLength(4),
      60_000,
    );
    expect(new Set(first.map((r) => r.requestId)).size).toBe(1);
    // The 200 that comes after 11 seconds is not waited for: the try fails at
    // 10 seconds, and the retry follows within the worker's one-second tick.
    const gap = (first[1]?.at ?? 0) - (first[0]?.at ?? 0);
    expect(gap).toBeGreaterThanOrEqual(10_000);
    expect(gap).toBeLessThan(12_000);
    await openTeam(page);
    await rowShows(page, "CRM", "last result HTTP 201");

    // 202 after 8 seconds is in time; 204 is a success too: one request each.
    await v.goto("/book/tess/intro");
    await book(v, at(day(1), "10:00"), "Bo", "bo@example.com");
    await eventually(
      async () => hook.log,
      (l) => expect(l).toHaveLength(5),
    );
    await rowShows(page, "CRM", "last result HTTP 202");
    await v.goto("/book/tess/intro");
    await book(v, at(day(2), "10:00"), "Cy", "cy@example.com");
    await eventually(
      async () => hook.log,
      (l) => expect(l).toHaveLength(6),
    );
    await rowShows(page, "CRM", "last result HTTP 204");
    await new Promise((r) => setTimeout(r, 2_000));
    expect(hook.log).toHaveLength(6);
    const titles = (await allEvents(cal)).map((e) => e.summary).join("\n");
    for (const name of ["Ada", "Bo", "Cy"]) expect(titles).toContain(name);
  } finally {
    await hook.close();
  }
});

test("an endpoint that fails for the whole period is suspended, gets no new requests and its admins get an email; Resume sends the waiting request (rule 15)", async ({
  page,
  app,
  browser,
  cal,
  signIn,
  mail,
}) => {
  // The period is 24 hours; the operator setting shortens it for the test.
  app.env.WEBHOOK_SUSPEND_AFTER_SECONDS = "4";
  await app.restart();
  const hook = await receiver();
  hook.state.fallback = 500;
  try {
    await blockUntil(cal, W);
    await signIn();
    await claimPage(page, "uma");
    await addLink(page, { title: "Demo", durations: "30" });
    await addWebhook(page, "CRM", hook.url);
    await attach(page, "Demo", "CRM");

    const v = await visitor(browser);
    await v.goto("/book/uma/demo");
    await book(v, at(W, "10:00"), "Dee", "dee@example.com");
    await openTeam(page);
    await expect
      .poll(
        async () => {
          await page.reload();
          return row(page, "CRM").locator(".badge").textContent();
        },
        { timeout: 45_000 },
      )
      .toBe("suspended");
    const note = await mail.message(EMAIL, /Webhook CRM is suspended/);
    expect(note.text).toContain("Tempoloom sends it no new requests until an admin resumes it.");
    expect(hook.log.length).toBeGreaterThanOrEqual(2);
    const tries = hook.log.length;

    // Suspended: no retries, and a new booking sends nothing.
    await v.goto("/book/uma/demo");
    await book(v, at(day(1), "10:00"), "Eli", "eli@example.com");
    await eventually(
      () => allEvents(cal),
      (l) => expect(l.some((e) => e.summary.includes("Eli"))).toBe(true),
    );
    await new Promise((r) => setTimeout(r, 4_000));
    expect(hook.log).toHaveLength(tries);

    // The receiver works again; Resume sends the waiting request at once.
    hook.state.fallback = 200;
    await row(page, "CRM").getByRole("button", { name: "Resume" }).click();
    await expect(row(page, "CRM").locator(".badge")).toHaveText("active");
    const after = await eventually(
      async () => hook.log,
      (l) => expect(l).toHaveLength(tries + 1),
    );
    expect(after.at(-1)?.requestId).toBe(after[0]?.requestId);
    await rowShows(page, "CRM", "last result HTTP 200");
    await expect(row(page, "CRM").locator(".badge")).toHaveText("active");
    expect((await allEvents(cal)).some((e) => e.summary.includes("Dee"))).toBe(true);
  } finally {
    await hook.close();
  }
});
