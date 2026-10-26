// Assistant chat checks that hold for any reasonable model answer. The suite
// runs them with the fake model (scripted like a model would answer);
// scripts/e2e-llm.sh runs them (tag @llm-real) against the real endpoint.
// They check what the app does, not the words: a proposal appears in preview
// mode, nothing is written before approval, and apply writes it.
import { addDays } from "../../src/shared/time.ts";
import { chatPanel, openAssistant, say } from "./assistant-helpers.ts";
import { type ChatRequest, toolJson } from "./fake-llm.ts";
import {
  at,
  type CalendarDriver,
  eventually,
  expect,
  local,
  planNow,
  REAL_LLM,
  test,
} from "./fixtures.ts";
import { W } from "./helpers.ts";
import { iso, previewPanel, reviewAndApply } from "./preview-helpers.ts";

const tue = addDays(W, 1);
const wed = addDays(W, 2);
const weekEvents = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(addDays(W, 7), "00:00"));
// A real model takes seconds per call and may call several tools.
const MODEL_MS = REAL_LLM ? 150_000 : 30_000;

test("a request in plain words stages a new event in preview mode; the calendar gets it only after approval @llm-real", async ({
  page,
  cal,
  signIn,
  llm,
}) => {
  test.setTimeout(REAL_LLM ? 400_000 : 180_000);
  llm.on(/quarterly planning/i, [
    {
      tools: [
        {
          name: "propose_create_event",
          arguments: {
            title: "Quarterly planning",
            start: iso(at(tue, "14:00")),
            end: iso(at(tue, "15:00")),
          },
        },
      ],
    },
    { content: "I staged Quarterly planning. It waits for your approval." },
  ]);
  await signIn();
  await page.goto(`/?week=${W}`);
  await openAssistant(page);
  expect(
    await say(
      page,
      `Please add an event titled "Quarterly planning" on ${tue} from 14:00 to 15:00, with no guests. Stage it directly; do not ask me questions.`,
      MODEL_MS,
    ),
  ).toBe(200);
  const card = chatPanel(page)
    .getByTestId("chat-proposal")
    .filter({ hasText: "Quarterly planning" });
  await expect(card.first()).toBeVisible();
  await expect(card.first()).toContainText("Waiting for your approval");

  // Nothing is written before approval.
  await planNow(page);
  expect((await weekEvents(cal)).filter((e) => /quarterly planning/i.test(e.summary))).toEqual([]);

  await chatPanel(page).getByRole("button", { name: "Close" }).click();
  await page.reload();
  await expect(previewPanel(page).getByTestId("staged-change").first()).toBeVisible();
  await reviewAndApply(page);
  await expect(page.getByTestId("apply-summary")).toContainText(/Applied [1-9]/);
  const [made] = await eventually(
    async () => (await weekEvents(cal)).filter((e) => /quarterly planning/i.test(e.summary)),
    (evs) => expect(evs.length).toBeGreaterThan(0),
  );
  expect(local(made?.start ?? 0)).toBe(`${tue} 14:00`);
  expect(local(made?.end ?? 0)).toBe(`${tue} 15:00`);
});

test("a move by chat reads the calendar first and waits in preview mode until the user applies it @llm-real", async ({
  page,
  cal,
  signIn,
  llm,
}) => {
  test.setTimeout(REAL_LLM ? 400_000 : 180_000);
  await cal.addEvent({ title: "Vendor call", start: at(wed, "10:00"), end: at(wed, "11:00") });
  llm.on(/vendor call/i, [
    {
      tools: [
        {
          name: "list_events",
          arguments: { start: iso(at(wed, "00:00")), end: iso(at(addDays(wed, 1), "00:00")) },
        },
      ],
    },
    (req: ChatRequest) => ({
      tools: [
        {
          name: "propose_update_event",
          arguments: {
            event_id: toolJson<{ events: { id: string; title: string }[] }>(
              req,
              "list_events",
            ).events.find((e) => e.title === "Vendor call")?.id,
            start: iso(at(wed, "16:00")),
            end: iso(at(wed, "17:00")),
          },
        },
      ],
    }),
    { content: "The move waits for your approval." },
  ]);
  await signIn();
  await page.goto(`/?week=${W}`);
  await expect(page.locator(".ev", { hasText: "Vendor call" })).toBeVisible();
  await openAssistant(page);
  expect(
    await say(
      page,
      `Move my "Vendor call" on ${wed} to 16:00-17:00 the same day. Stage it directly; do not ask me questions.`,
      MODEL_MS,
    ),
  ).toBe(200);
  await expect(chatPanel(page).getByTestId("chat-proposal").first()).toContainText("Vendor call");

  await planNow(page);
  const vendor = async () =>
    (await weekEvents(cal)).filter((e) => e.summary === "Vendor call").map((e) => local(e.start));
  expect(await vendor()).toEqual([`${wed} 10:00`]);
  await chatPanel(page).getByRole("button", { name: "Close" }).click();
  await reviewAndApply(page);
  await eventually(vendor, (v) => expect(v).toEqual([`${wed} 16:00`]));
});
