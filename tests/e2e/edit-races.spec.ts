// Edits that race with other changes (automations-overview.md rule 11,
// decision "an edit sends only the fields it changed").
//
// Ways it can fail, and the check that catches each:
// - a meeting form opened before another client's change writes the old
//   value back                                     -> the other location stays
// - a habit form does the same                     -> the other notes stay
// - the meeting Edit buttons come back while a second change is still saving,
//   so an edit can start from the old meeting      -> Edit stays disabled
// - a settings checkbox shows the old value during its save, so a fast second
//   click saves the same value again               -> checked during the save,
//                                                     the second click wins
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { addHabit } from "./helpers.ts";

const MEETING = {
  attendees: [{ email: "dana@example.com" }],
  frequency: { period: "weekly", everyWeeks: 1, idealDays: [2] },
  idealTime: "10:00",
  durationMinutes: 30,
};

interface MeetingView {
  id: string;
  title: string;
  location: string;
  description: string;
}

async function meetings(page: Page): Promise<MeetingView[]> {
  const res = await page.request.get("/api/meetings");
  expect(res.status()).toBe(200);
  return ((await res.json()) as { meetings: MeetingView[] }).meetings;
}

async function addMeeting(page: Page, title: string): Promise<string> {
  const res = await page.request.post("/api/meetings", { data: { ...MEETING, title } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

test("a meeting form opened before another client's change saves only its own fields", async ({
  page,
  signIn,
}) => {
  await signIn();
  const id = await addMeeting(page, "ER-Standup");
  await page.getByRole("link", { name: "Meetings" }).click();
  const row = page.locator('[data-meeting-title="ER-Standup"]');
  await row.getByRole("button", { name: "Edit" }).click();
  const form = page.getByTestId("meeting-form");
  await expect(form.getByLabel("Title")).toHaveValue("ER-Standup");

  // Another client (the full body, as the API takes it) sets a location.
  const other = await page.request.put(`/api/meetings/${id}`, {
    data: { ...MEETING, title: "ER-Standup", location: "Room B" },
  });
  expect(other.status()).toBe(200);

  await form.getByLabel("Title").fill("ER-Standup weekly");
  await form.getByLabel("Description").fill("Notes from this form");
  await form.getByRole("button", { name: "Save meeting" }).click();
  await expect
    .poll(async () => (await meetings(page)).find((m) => m.id === id)?.title)
    .toBe("ER-Standup weekly");
  const saved = (await meetings(page)).find((m) => m.id === id);
  expect(saved?.location).toBe("Room B");
  expect(saved?.description).toBe("Notes from this form");
  await page.reload();
  await expect(page.locator('[data-meeting-title="ER-Standup weekly"]')).toBeVisible();
});

test("a habit form opened before another client's change saves only its own fields", async ({
  page,
  signIn,
}) => {
  await signIn();
  await addHabit(page, { title: "ER-Reading", ideal: "11:00", min: 30, max: 30 });
  const list = (await (await page.request.get("/api/habits")).json()) as {
    habits: { id: string; title: string; notes: string }[];
  };
  const habit = list.habits.find((h) => h.title === "ER-Reading");
  expect(habit).toBeTruthy();
  await page
    .locator('[data-habit-title="ER-Reading"]')
    .getByRole("button", { name: "Edit" })
    .click();
  const editor = page.getByTestId("habit-editor");
  await expect(editor.getByLabel("Title")).toHaveValue("ER-Reading");

  const other = await page.request.patch(`/api/habits/${habit?.id}`, {
    data: { notes: "Chapter 4" },
  });
  expect(other.status()).toBe(200);

  await editor.getByLabel("Title").fill("ER-Reading time");
  await editor.getByRole("button", { name: "Save habit" }).click();
  const read = async () =>
    ((await (await page.request.get("/api/habits")).json()) as typeof list).habits.find(
      (h) => h.id === habit?.id,
    );
  await expect.poll(async () => (await read())?.title).toBe("ER-Reading time");
  expect((await read())?.notes).toBe("Chapter 4");
});

test("the meeting Edit buttons stay off until every change of the page shows", async ({
  page,
  signIn,
}) => {
  await signIn();
  const slow = await addMeeting(page, "ER-Slow");
  await addMeeting(page, "ER-Fast");
  await page.getByRole("link", { name: "Meetings" }).click();
  const slowRow = page.locator('[data-meeting-title="ER-Slow"]');
  const fastRow = page.locator('[data-meeting-title="ER-Fast"]');
  await expect(fastRow.getByRole("button", { name: "Edit" })).toBeEnabled();

  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route(
    (url) => url.pathname === `/api/meetings/${slow}/enabled`,
    async (route) => {
      await held;
      await route.continue();
    },
  );
  await slowRow.getByRole("button", { name: "Turn off" }).click();
  await fastRow.getByRole("button", { name: "Turn off" }).click();
  await expect(fastRow.getByRole("button", { name: "Turn on" })).toBeVisible();
  // The fast change shows; the slow one is still saving, so no edit may start.
  await expect(fastRow.getByRole("button", { name: "Edit" })).toBeDisabled();
  await page.waitForTimeout(500);
  await expect(slowRow.getByRole("button", { name: "Edit" })).toBeDisabled();
  release();
  await expect(slowRow.getByRole("button", { name: "Turn on" })).toBeVisible();
  await expect(slowRow.getByRole("button", { name: "Edit" })).toBeEnabled();
});

test("a settings checkbox shows its new value while it saves, and a fast second click wins", async ({
  page,
  signIn,
}) => {
  await signIn();
  await page.goto("/settings");
  const tips = page.getByLabel("Add tips to event descriptions");
  const tab = page.getByLabel("Flash the tab title when an event starts");
  // The default is on.
  await expect(tab).toBeChecked();
  // A first save shows "Saved"; the next save clears it, so the page draws during the save.
  await tips.click();
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");

  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  const bodies: unknown[] = [];
  await page.route(
    (url) => url.pathname === "/api/settings",
    async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      bodies.push(route.request().postDataJSON());
      await held;
      await route.continue();
    },
  );
  await tab.click();
  await expect.poll(() => bodies.length).toBe(1);
  await expect(page.getByTestId("settings-message")).toHaveCount(0);
  await expect(tab).not.toBeChecked();
  await tab.click();
  await expect(tab).toBeChecked();
  release();
  await expect.poll(() => bodies).toEqual([{ tabAlert: false }, { tabAlert: true }]);
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  await expect
    .poll(
      async () =>
        (
          (await (await page.request.get("/api/settings")).json()) as {
            settings: { tabAlert: boolean };
          }
        ).settings.tabAlert,
    )
    .toBe(true);
  await page.reload();
  await expect(tab).toBeChecked();
});
