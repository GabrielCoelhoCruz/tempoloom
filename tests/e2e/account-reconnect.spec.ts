// Disconnected accounts and reconnect (docs/specs/accounts-login-emails-permissions.md
// rules 14-16, AT-5). The CalDAV server stops taking an added account's stored
// password, the way a revoked Google token stops working.
//
// Ways it can fail, and the check that catches each:
// - the lost login is not shown, or stops the user's whole sync      -> "Disconnected"; a task is placed
// - Tempoloom keeps reading the account's calendars                  -> a new source event gets no copy
// - policies that use it show no error                               -> paused note on the policy
// - reconnect takes a wrong password, or does not resume the policy  -> refusal; the copy appears
// - the status is not stored                                         -> reload after each step
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import { addPolicy, copies, policyRow, week } from "./calendar-helpers.ts";
import { addCalDavAccount, openAccount } from "./delegation-helpers.ts";
import { at, BACKEND, blockUntil, EMAIL, eventually, expect, planNow, test } from "./fixtures.ts";
import { addTask, allEvents, titled, W } from "./helpers.ts";
import { putEvent } from "./ics.ts";

test.skip(BACKEND === "google", "The test changes a password on the loopback CalDAV server.");

const STATE = join(
  process.env.TEMPOLOOM_E2E_STATE ?? join(homedir(), ".local/state/tempoloom"),
  "radicale",
);

/** Sets a Radicale user's password (scripts/caldav-server.sh files); Radicale reads them on each request. */
function setPassword(user: string, n: number, password: string): void {
  const users = join(STATE, "config/users");
  const lines = readFileSync(users, "utf8")
    .split("\n")
    .map((l) => (l.startsWith(`${user}:`) ? `${user}:${password}` : l));
  writeFileSync(users, lines.join("\n"));
  writeFileSync(join(STATE, `password${n}`), `${password}\n`);
}

const accountRow = (page: Page, email: string) =>
  page.getByTestId("account-list").locator(`[data-account="${email}"]`);

test("an account whose login stops working shows Disconnected, pauses its policies and nothing else; reconnect resumes them (rules 14-16, AT-5)", async ({
  page,
  cal,
  signIn,
  people,
  radicale,
}) => {
  const six = radicale?.users[6];
  if (!radicale || !six) throw new Error("This test needs the CalDAV backend.");
  const extra = await people(6);
  const theirs = `Work (${extra.email})`;
  const mine = `Work (${EMAIL})`;
  try {
    await blockUntil(cal, W);
    await signIn();
    await addCalDavAccount(page, { ...six, email: extra.email });
    await expect(accountRow(page, extra.email).getByTestId("account-status")).toHaveText(
      "Connected",
    );
    await extra.cal.addEvent({ title: "Gym", start: at(W, "07:00"), end: at(W, "08:00") });
    await addPolicy(page, { from: theirs, to: mine });
    await eventually(
      () => week(cal),
      (l) => expect(copies(l)).toHaveLength(1),
    );

    // The server no longer takes the stored password.
    const fresh = `new-${Date.now()}`;
    setPassword(six.username, 6, fresh);
    await planNow(page);
    await openAccount(page);
    await expect
      .poll(
        async () => {
          await page.reload();
          return accountRow(page, extra.email).getByTestId("account-status").textContent();
        },
        { timeout: 45_000 },
      )
      .toBe("Disconnected");
    await expect(accountRow(page, EMAIL).getByTestId("account-status")).toHaveText("Connected");
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page.getByTestId("mirror-disconnected")).toHaveText(
      ` · Paused: ${extra.email} is disconnected. Reconnect it on the Account page.`,
    );

    // The user's own planning goes on; the disconnected calendar is not read.
    await putEvent(extra.cal.calendarId, [
      `DTSTART:${new Date(at(addDays(W, 1), "07:00")).toISOString().replace(/[-:]|\.\d{3}/g, "")}`,
      `DTEND:${new Date(at(addDays(W, 1), "08:00")).toISOString().replace(/[-:]|\.\d{3}/g, "")}`,
      "SUMMARY:Swim",
    ]);
    await addTask(page, { title: "AT-Still", minutes: 60, split: false, due: "" });
    await eventually(
      () => allEvents(cal),
      (l) => expect(titled(l, "AT-Still")).toHaveLength(1),
    );
    await planNow(page);
    expect(copies(await week(cal))).toHaveLength(1);

    // Reconnect: a wrong password is refused, the new one works.
    await openAccount(page);
    await accountRow(page, extra.email).getByRole("button", { name: "Reconnect" }).click();
    const form = page.getByTestId("reconnect-form");
    await form.getByLabel(`Password for ${extra.email}`).fill("wrong");
    await form.getByRole("button", { name: "Reconnect account" }).click();
    await expect(page.getByTestId("account-message")).toHaveText(
      "The server rejected this password.",
    );
    await expect(accountRow(page, extra.email).getByTestId("account-status")).toHaveText(
      "Disconnected",
    );
    await form.getByLabel(`Password for ${extra.email}`).fill(fresh);
    await form.getByRole("button", { name: "Reconnect account" }).click();
    await expect(page.getByTestId("account-message")).toHaveText(
      `${extra.email} is connected again.`,
    );
    await expect(accountRow(page, extra.email).getByTestId("account-status")).toHaveText(
      "Connected",
    );
    await eventually(
      () => week(cal),
      (l) => expect(copies(l)).toHaveLength(2),
    );
    await page.reload();
    await expect(accountRow(page, extra.email).getByTestId("account-status")).toHaveText(
      "Connected",
    );
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(policyRow(page, `${theirs} → ${mine}`)).toBeVisible();
    await expect(page.getByTestId("mirror-disconnected")).toHaveCount(0);
  } finally {
    setPassword(six.username, 6, six.password);
  }
});
