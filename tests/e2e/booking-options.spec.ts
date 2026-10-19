// Booking link options: screening questions and the redirect after booking.
// Specs: booking-links.md (question record, rules 12 and 15, edge case 8),
// booking-links-booking-page.md rules 13, 14 and 17.
//
// Ways this can fail:
//  1. The editor loses a question, its order, its answer type, its choices or
//     its required flag on save or after a reload.
//  2. The booking form does not show the questions, or not in their order.
//  3. A required question can stay empty: the page books anyway, or the API
//     takes a booking without the answer (a request that skips the page).
//  4. A choice answer outside the choices is accepted.
//  5. The answers do not reach the event description on the calendar.
//  6. The page never redirects, redirects at once (the booker never sees the
//     confirmation), or much later than 7 seconds.
//  7. A redirect URL that does not start with https:// is saved.
//  8. The booking is lost when the page goes to the redirect URL.
import { at, blockUntil, eventually, expect, test } from "./fixtures.ts";
import { addLink, allEvents, claimPage, slot, visitor, W } from "./helpers.ts";
import { editLink, saveLink } from "./link-helpers.ts";

const bookApi = (v: import("@playwright/test").Page, path: string, body: Record<string, unknown>) =>
  v.evaluate(
    async ([p, b]) =>
      (
        await fetch(p, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(b),
        })
      ).status,
    [path, body] as const,
  );

test("screening questions: the owner adds them, the booker must answer the required one, and the answers reach the event (questions, rules 12-14)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await claimPage(page, "quinn");
  await addLink(page, { title: "Intro", durations: "30" });
  const ed = await editLink(page, "Intro");
  await ed.getByRole("button", { name: "+ Add question" }).click();
  await ed.getByLabel("Question 1", { exact: true }).fill("What is your company?");
  await ed.getByTestId("question-1").getByLabel("Required").check();
  await ed.getByRole("button", { name: "+ Add question" }).click();
  await ed.getByLabel("Question 2", { exact: true }).fill("Topic");
  await ed.getByTestId("question-2").getByLabel("Answer type").selectOption({ label: "Choice" });
  await ed
    .getByTestId("question-2")
    .getByLabel(/^Choices/)
    .fill("Sales, Support");
  await ed.getByRole("button", { name: "+ Add question" }).click();
  await ed.getByLabel("Question 3", { exact: true }).fill("Anything else?");
  await ed
    .getByTestId("question-3")
    .getByLabel("Answer type")
    .selectOption({ label: "Several lines" });
  await saveLink(page);

  await page.reload();
  const again = await editLink(page, "Intro");
  await expect(again.getByLabel("Question 1", { exact: true })).toHaveValue(
    "What is your company?",
  );
  await expect(again.getByTestId("question-1").getByLabel("Required")).toBeChecked();
  await expect(again.getByTestId("question-2").getByLabel("Answer type")).toHaveValue("choice");
  await expect(again.getByTestId("question-2").getByLabel(/^Choices/)).toHaveValue(
    "Sales, Support",
  );
  await expect(again.getByTestId("question-2").getByLabel("Required")).not.toBeChecked();
  await expect(again.getByTestId("question-3").getByLabel("Answer type")).toHaveValue("multiLine");

  const v = await visitor(browser);
  await v.goto("/book/quinn/intro");
  await slot(v, at(W, "10:00")).click();
  const form = v.getByTestId("book-form");
  await expect(form.getByTestId("question")).toHaveText([
    "What is your company? (required)",
    "Topic",
    "Anything else?",
  ]);
  await form.getByLabel("Your name").fill("Rae");
  await form.getByLabel("Your email").fill("rae@example.com");
  await form.getByRole("button", { name: "Book" }).click();
  await expect(v.getByRole("alert")).toContainText("What is your company?");
  await expect(form).toBeVisible();
  expect((await allEvents(cal)).filter((e) => e.summary.includes("Rae"))).toHaveLength(0);

  // Requests that skip the page are refused: no answer, or a choice outside the list.
  expect(
    await bookApi(v, "/pub/pages/quinn/intro/book", {
      start: at(W, "10:00"),
      duration: 30,
      name: "Sly",
      email: "sly@example.com",
    }),
  ).toBe(400);
  expect(
    await bookApi(v, "/pub/pages/quinn/intro/book", {
      start: at(W, "10:00"),
      duration: 30,
      name: "Sly",
      email: "sly@example.com",
      answers: ["Acme", "Marketing", ""],
    }),
  ).toBe(400);

  await form.getByLabel(/^What is your company\?/).fill("Acme");
  await form.getByLabel("Topic").selectOption("Support");
  await form.getByLabel("Anything else?").fill("Line one\nLine two");
  await form.getByRole("button", { name: "Book" }).click();
  await expect(v.getByTestId("booked")).toBeVisible();
  const evs = await eventually(
    () => allEvents(cal),
    (l) => expect(l.find((e) => e.summary === "Intro with Rae")).toBeDefined(),
  );
  const description = evs.find((e) => e.summary === "Intro with Rae")?.description ?? "";
  expect(description).toContain("What is your company?\nAcme");
  expect(description).toContain("Topic\nSupport");
  expect(description).toContain("Anything else?\nLine one\nLine two");
  expect(description.indexOf("What is your company?")).toBeLessThan(description.indexOf("Topic"));
  expect((await allEvents(cal)).filter((e) => e.summary.includes("Sly"))).toHaveLength(0);

  await v.goto("/book/quinn/intro");
  await expect(v.getByTestId("times")).toBeVisible();
  await expect(slot(v, at(W, "10:00"))).toHaveCount(0);
});

test("redirect after booking: the confirmation shows, then the browser opens the https page 7 seconds later; an http URL is refused (rule 15, edge case 8)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await claimPage(page, "remy");
  await addLink(page, { title: "Demo", durations: "30" });
  let ed = await editLink(page, "Demo");
  await ed.getByLabel(/^Redirect after booking/).fill("http://example.com/thanks");
  await ed.getByRole("button", { name: "Save link" }).click();
  await expect(ed.getByRole("alert")).toContainText("https://");
  await page.reload();
  ed = await editLink(page, "Demo");
  await expect(ed.getByLabel(/^Redirect after booking/)).toHaveValue("");
  await ed.getByLabel(/^Redirect after booking/).fill("https://after.tempoloom.test/thanks");
  await saveLink(page);

  const v = await visitor(browser);
  await v
    .context()
    .route("https://after.tempoloom.test/**", (r) =>
      r.fulfill({ contentType: "text/html", body: "<h1>Thanks from the test page</h1>" }),
    );
  await v.goto("/book/remy/demo");
  await slot(v, at(W, "10:00")).click();
  const form = v.getByTestId("book-form");
  await form.getByLabel("Your name").fill("Uma");
  await form.getByLabel("Your email").fill("uma@example.com");
  await form.getByRole("button", { name: "Book" }).click();
  await expect(v.getByTestId("booked")).toBeVisible();
  const shown = Date.now();
  await expect(v.getByTestId("redirect-note")).toContainText("https://after.tempoloom.test/thanks");
  await v.waitForURL("https://after.tempoloom.test/thanks", { timeout: 20_000 });
  const elapsed = Date.now() - shown;
  expect(elapsed).toBeGreaterThanOrEqual(6_000);
  expect(elapsed).toBeLessThanOrEqual(9_000);
  await expect(v.getByRole("heading")).toHaveText("Thanks from the test page");

  await eventually(
    () => allEvents(cal),
    (l) => expect(l.find((e) => e.summary === "Demo with Uma")).toBeDefined(),
  );
  await page.reload();
  await expect(page.getByTestId("booking-list")).toContainText("Uma");
  ed = await editLink(page, "Demo");
  await expect(ed.getByLabel(/^Redirect after booking/)).toHaveValue(
    "https://after.tempoloom.test/thanks",
  );
});
