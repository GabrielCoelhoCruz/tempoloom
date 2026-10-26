// The planner's offer of assistant chat after sign-up (teams-settings-templates.md
// rule 15) with the fake model, and the Task re-ranking library entry with a real
// model (@llm-real; only scripts/e2e-llm.sh runs it).
//
// Ways this can fail, each covered below:
// - after sign-up the planner does not offer chat, offers it again after the
//   user chatted or said Not now, or offers it to a member who cannot turn it on;
// - with a real model, a re-ranking writes before approval, or a staged
//   priority is skipped at apply.
import { addDays } from "../../src/shared/time.ts";
import { openEntry, prompt, reply, sendDraft, systemOf } from "./assistant-C2-helpers.ts";
import { chatPanel } from "./assistant-helpers.ts";
import { BACKEND, blockUntil, COLLEAGUE_EMAIL, EMAIL, expect, REAL_LLM, test } from "./fixtures.ts";
import { addTask, W } from "./helpers.ts";
import { previewPanel, reviewAndApply } from "./preview-helpers.ts";
import { openTeam, teamOfTwo } from "./team-helpers.ts";

test.skip(BACKEND === "google", "Assistant chat E2E runs on CalDAV.");

test("after sign-up the planner offers assistant chat: Try the assistant opens the panel with a first question; after a chat, or after Not now, the offer stays away (teams-settings-templates rule 15)", async ({
  page,
  signIn,
  colleague,
  llm,
}) => {
  llm.on(/what is on my calendar this week/i, [{ content: "Nothing yet this week." }]);
  await signIn();
  const offer = page.getByTestId("hint-assistant-chat");
  await expect(offer).toContainText("Ask the assistant about your calendar");
  await page.reload();
  await expect(offer).toBeVisible();
  await offer.getByRole("button", { name: "Try the assistant" }).click();
  await expect(chatPanel(page).getByLabel("Message to the assistant")).toHaveValue(
    "What is on my calendar this week?",
  );
  await expect(offer).toHaveCount(0);
  expect(llm.requests).toHaveLength(0);
  await sendDraft(page);
  await expect(reply(page)).toHaveText("Nothing yet this week.");
  expect(llm.requests).toHaveLength(1);
  await page.reload();
  await expect(page.getByTestId("planner-hints")).toHaveAttribute("data-loaded", "true");
  await expect(offer).toHaveCount(0);

  // Another new user says Not now: the offer stays away after reload, and nothing is sent.
  const pb = await colleague.signIn();
  await pb.goto("/");
  const other = pb.getByTestId("hint-assistant-chat");
  await other.getByRole("button", { name: "Not now" }).click();
  await expect(other).toHaveCount(0);
  await pb.reload();
  await expect(pb.getByTestId("planner-hints")).toHaveAttribute("data-loaded", "true");
  await expect(other).toHaveCount(0);
  expect(llm.requests).toHaveLength(1);
});

test("while the team switch is off, the offer lets an admin turn assistant chat on for the team, and a member gets no offer until then (teams-settings-templates rules 13, 15)", async ({
  page,
  signIn,
  colleague,
  mail,
  llm,
}) => {
  llm.on(/what is on my calendar this week/i, [{ content: "Nothing yet this week." }]);
  const pb = await teamOfTwo(page, signIn, colleague, mail);
  await openTeam(page);
  const form = page.getByTestId("team-settings");
  await form.getByLabel("Assistant chat for all members").uncheck();
  await form.getByRole("button", { name: "Save team settings" }).click();
  await expect(form.getByTestId("team-settings-saved")).toBeVisible();

  // The member cannot turn chat on: no offer.
  await pb.goto("/");
  await expect(pb.getByTestId("planner-hints")).toHaveAttribute("data-loaded", "true");
  await expect(pb.getByTestId("hint-assistant-chat")).toHaveCount(0);

  // The admin's offer turns chat on for the whole team, then opens the panel.
  await page.goto("/");
  const offer = page.getByTestId("hint-assistant-chat");
  await expect(offer).toContainText("Assistant chat is off for your team.");
  await offer.getByRole("button", { name: "Turn on assistant chat" }).click();
  await expect(chatPanel(page).getByLabel("Message to the assistant")).toHaveValue(
    "What is on my calendar this week?",
  );
  await sendDraft(page);
  await expect(reply(page)).toHaveText("Nothing yet this week.");
  await openTeam(page);
  await page.reload();
  await expect(
    page.getByTestId("team-settings").getByLabel("Assistant chat for all members"),
  ).toBeChecked();

  // Now the member gets the offer, and the panel works for them.
  await pb.reload();
  const theirs = pb.getByTestId("hint-assistant-chat");
  await expect(theirs).toContainText("Ask the assistant about your calendar");
  await theirs.getByRole("button", { name: "Try the assistant" }).click();
  await sendDraft(pb);
  await expect(reply(pb)).toHaveText("Nothing yet this week.");
  expect(llm.requests).toHaveLength(2);
  expect(llm.requests.map((r) => systemOf(r))).toEqual([
    expect.stringContaining(EMAIL),
    expect.stringContaining(COLLEAGUE_EMAIL),
  ]);
});

test("the Task re-ranking entry with a real model stages new priorities in preview mode; the tasks change only after apply, and every staged priority applies @llm-real", async ({
  page,
  cal,
  signIn,
}) => {
  test.skip(!REAL_LLM, "Needs the real model: run scripts/e2e-llm.sh");
  test.setTimeout(400_000);
  await blockUntil(cal, W);
  await signIn();
  // The priorities are the wrong way round: the task due first has the lowest one.
  await addTask(page, {
    title: "Tax filing",
    minutes: 120,
    due: `${addDays(W, 1)}T17:00`,
    level: 4,
  });
  await addTask(page, {
    title: "Team offsite ideas",
    minutes: 30,
    due: `${addDays(W, 25)}T17:00`,
    level: 1,
  });
  const box = await openEntry(page, "Task re-ranking");
  await box.fill(
    `${prompt("Task re-ranking")} Stage the changes directly; do not ask me questions.`,
  );
  const answer = page.waitForResponse(
    (r) => r.url().endsWith("/api/assistant/messages") && r.request().method() === "POST",
    { timeout: 150_000 },
  );
  await chatPanel(page).getByRole("button", { name: "Send" }).click();
  expect((await answer).status()).toBe(200);
  const cards = chatPanel(page)
    .getByTestId("chat-proposal")
    .filter({ hasText: "New priority" })
    .filter({ hasText: "Waiting for your approval" });
  await expect(cards.first()).toBeVisible();
  // The priority each task gets when every staged change applies.
  const want = new Map([
    ["Tax filing", "P4 low"],
    ["Team offsite ideas", "P1 critical"],
  ]);
  const NAMES: Record<string, string> = {
    1: "P1 critical",
    2: "P2 high",
    3: "P3 medium",
    4: "P4 low",
  };
  const staged = await cards.locator("strong").allTextContents();
  for (const text of staged) {
    const m = /New priority P\d to P(\d) for task "(.+)"$/.exec(text);
    if (!m) throw new Error(`unexpected proposal: ${text}`);
    want.set(m[2] as string, NAMES[m[1] as string] as string);
  }

  // Nothing changed before approval.
  const levels = async () => {
    await page.getByRole("link", { name: "Tasks" }).click();
    return Promise.all(
      ["Tax filing", "Team offsite ideas"].map((t) =>
        page.locator(`[data-task-title="${t}"]`).getByTestId("task-level").textContent(),
      ),
    );
  };
  expect(await levels()).toEqual(["P4 low", "P1 critical"]);

  await page.goto("/");
  // Only the priority changes count here: the model may stage other changes too.
  const rows = previewPanel(page).getByTestId("staged-change");
  await expect(rows.filter({ hasText: "New priority" })).toHaveCount(staged.length);
  const all = await rows.count();
  await reviewAndApply(page);
  // Every staged priority applies: none is skipped as stale.
  await expect(page.getByTestId("apply-summary")).toContainText(
    `Applied ${all} · Skipped as stale 0 · Failed 0`,
  );
  await page.reload();
  expect(await levels()).toEqual([want.get("Tax filing"), want.get("Team offsite ideas")]);
  expect(await levels()).not.toEqual(["P4 low", "P1 critical"]);
});
