// Assistant chat (docs/specs/assistant-chat.md) through the planner panel, with
// the fake model (tests/e2e/fake-llm.ts): how a reply shows.
//
// Ways this can fail, each covered below:
// - a reply in markdown shows its markers ("**", "- ") instead of bold and lists;
// - a link in the model's text becomes a link, or the user's own text is parsed.
import { chatPanel, openAssistant, say } from "./assistant-helpers.ts";
import { expect, test } from "./fixtures.ts";
import { W } from "./helpers.ts";

test("a reply in markdown shows bold, italic, lists and code without the markers; links and the user's own text stay plain text (assistant-chat rule 1)", async ({
  page,
  signIn,
  llm,
}) => {
  llm.on(/look like/i, [
    {
      content: [
        "Your **Wednesday**:",
        "- **Wednesday 4 Nov:** Team standup 09:30-10:00",
        "- *Design review* at `14:00`",
        "",
        "1. Read the [agenda](https://evil.example/agenda)",
        "2. Then _rest_",
      ].join("\n"),
    },
  ]);
  await signIn();
  await page.goto(`/?week=${W}`);
  await openAssistant(page);
  const asked = "What does **Wednesday** look like?";
  expect(await say(page, asked)).toBe(200);

  const reply = chatPanel(page).getByTestId("chat-assistant");
  for (const view of ["sent", "after reload"]) {
    if (view === "after reload") {
      await page.reload();
      await openAssistant(page);
    }
    await expect(reply.locator("strong")).toHaveText(["Wednesday", "Wednesday 4 Nov:"]);
    await expect(reply.locator("ul > li")).toHaveText([
      "Wednesday 4 Nov: Team standup 09:30-10:00",
      "Design review at 14:00",
    ]);
    await expect(reply.locator("ol > li")).toHaveText([
      "Read the [agenda](https://evil.example/agenda)",
      "Then rest",
    ]);
    await expect(reply.locator("em")).toHaveText(["Design review", "rest"]);
    await expect(reply.locator("code")).toHaveText(["14:00"]);
    await expect(reply).not.toContainText("**");
    // The model's text can carry other people's text: no link, no markup.
    await expect(reply.locator("a, img")).toHaveCount(0);
    // The user's own message stays as typed.
    await expect(chatPanel(page).getByTestId("chat-user")).toHaveText([asked]);
    await expect(chatPanel(page).getByTestId("chat-user").locator("strong")).toHaveCount(0);
  }
});
