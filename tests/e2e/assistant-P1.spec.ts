// Assistant chat (docs/specs/assistant-chat.md) through the planner panel, with
// the fake model (tests/e2e/fake-llm.ts): how a reply shows, and the delete of
// a conversation.
//
// Ways this can fail, each covered below:
// - a reply in markdown shows its markers ("**", "- ") instead of bold and lists;
// - a link in the model's text becomes a link, or the user's own text is parsed;
// - a deleted conversation is still listed, still answers the API, or still
//   reaches the model as history;
// - another user can delete a conversation;
// - the delete takes the changes it staged, the saved memories or the day's
//   use with it, or keeps the memories it proposed and its message ids;
// - "Reply in chat" on a change of a deleted conversation fails;
// - after the delete of one of two chats, the other one cannot be opened again.
import { addDays } from "../../src/shared/time.ts";
import { chatPanel, openAssistant, proposal, say } from "./assistant-helpers.ts";
import { at, BASE_URL, eventually, expect, local, test } from "./fixtures.ts";
import { W } from "./helpers.ts";
import { iso, previewPanel, reviewAndApply, stagedRow } from "./preview-helpers.ts";

const tue = addDays(W, 1);

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

test("delete a conversation: it leaves the list, the API and the model's history, only for its owner; its staged change still applies, saved memories and the day's use stay, its proposed memories and message ids go", async ({
  page,
  cal,
  signIn,
  llm,
  app,
  colleague,
}) => {
  const saved = "Keep Friday afternoons free";
  const pending = "No meetings before 10:00";
  llm.on(/book deep work/i, [
    {
      tools: [
        {
          name: "propose_create_event",
          arguments: {
            title: "Deep work",
            start: iso(at(tue, "13:00")),
            end: iso(at(tue, "15:00")),
          },
        },
      ],
    },
    { content: "Deep work waits for your approval." },
  ]);
  llm.on(/^remember: friday/i, [
    { tools: [{ name: "save_memory", arguments: { text: saved } }] },
    { content: "Save it to keep it." },
  ]);
  llm.on(/^remember: mornings/i, [
    { tools: [{ name: "save_memory", arguments: { text: pending } }] },
    { content: "Save it to keep it." },
  ]);
  llm.on(/^about/i, [{ content: "Tell me the new time." }]);
  llm.on(/^anything else/i, [{ content: "Nothing else today." }]);

  await signIn();
  await page.goto(`/?week=${W}`);
  await openAssistant(page);
  await say(page, "Book deep work on Tuesday 13:00 to 15:00");
  await expect(proposal(page, "Deep work")).toContainText("Waiting for your approval");
  await say(page, "Remember: Friday afternoons");
  await chatPanel(page)
    .getByTestId("chat-memory")
    .getByRole("button", { name: "Save memory" })
    .click();
  await expect(chatPanel(page).getByTestId("chat-memory")).toHaveText(
    `Saved to memories: ${saved}`,
  );
  await say(page, "Remember: mornings");
  await expect(chatPanel(page).getByTestId("chat-memory").last()).toContainText(
    `Remember: ${pending}`,
  );

  type Panel = {
    conversationId: string | null;
    conversations: { id: string; title: string }[];
    items: unknown[];
  };
  const panelOf = async (query = "") =>
    (await (await page.request.get(`/api/assistant${query}`)).json()) as Panel;
  const cid = (await panelOf()).conversationId as string;
  expect(cid).toBeTruthy();
  const count = (sql: string) => app.query<{ n: number }>(sql, cid)[0]?.n;
  expect(count("SELECT count(*) AS n FROM assistant_requests WHERE conversation_id = ?")).toBe(3);
  const used = () => app.query<{ count: number }>("SELECT count FROM assistant_usage");
  expect(used()).toEqual([{ count: 3 }]);

  // Another user cannot delete it: 404, as for the other assistant routes, and it stays.
  const pb = await colleague.signIn();
  const theirs = await pb.request.delete(`/api/assistant/conversations/${cid}`, {
    headers: { origin: BASE_URL },
  });
  expect(theirs.status()).toBe(404);
  expect((await panelOf(`?conversation=${cid}`)).conversationId).toBe(cid);

  // The owner deletes it in the panel, after a confirm.
  await chatPanel(page).getByRole("button", { name: "Delete chat" }).click();
  const confirm = chatPanel(page).getByRole("alertdialog", { name: "Delete this chat" });
  await expect(confirm).toContainText("Changes it staged stay in preview mode");
  const deleted = page.waitForResponse(
    (r) => r.url().includes("/api/assistant/conversations/") && r.request().method() === "DELETE",
  );
  await confirm.getByRole("button", { name: "Yes, delete" }).click();
  expect((await deleted).status()).toBe(200);
  await expect(chatPanel(page).getByTestId("chat-user")).toHaveCount(0);
  await expect(chatPanel(page).getByRole("button", { name: "Delete chat" })).toHaveCount(0);

  await page.reload();
  await openAssistant(page);
  await expect(chatPanel(page).getByTestId("assistant-log")).toContainText(
    "Every change waits for your approval",
  );
  await expect(chatPanel(page).getByTestId("chat-user")).toHaveCount(0);
  expect(await panelOf()).toMatchObject({ conversationId: null, conversations: [], items: [] });
  expect(await panelOf(`?conversation=${cid}`)).toMatchObject({ conversationId: null, items: [] });
  const again = await page.request.delete(`/api/assistant/conversations/${cid}`, {
    headers: { origin: BASE_URL },
  });
  expect(again.status()).toBe(404);

  // The saved memory stays; the one it proposed and the user never saved is gone.
  await chatPanel(page).getByRole("button", { name: "Memories" }).click();
  await expect(chatPanel(page).getByTestId("memory").locator("span")).toHaveText([saved]);
  await chatPanel(page).getByRole("button", { name: "Memories" }).click();
  expect(
    app.query<{ text: string; state: string }>("SELECT text, state FROM assistant_memories"),
  ).toEqual([{ text: saved, state: "saved" }]);
  // The day's use does not go down; the message ids went with the conversation.
  expect(used()).toEqual([{ count: 3 }]);
  expect(count("SELECT count(*) AS n FROM assistant_requests WHERE conversation_id = ?")).toBe(0);
  expect(count("SELECT count(*) AS n FROM assistant_messages WHERE conversation_id = ?")).toBe(0);

  // Its staged change stays in preview mode. "Reply in chat" opens a new chat
  // with the reply in the draft, and the deleted messages do not reach the model.
  await chatPanel(page).getByRole("button", { name: "Close" }).click();
  const row = stagedRow(page, "Deep work");
  await expect(row).toContainText("Assistant chat");
  await row.getByRole("button", { name: "Reply in chat" }).click();
  const box = chatPanel(page).getByLabel("Message to the assistant");
  await expect(box).toHaveValue(/^About “Create “Deep work”/);
  const draft = await box.inputValue();
  expect(await say(page, `${draft}make it 14:00 to 16:00`)).toBe(200);
  await expect(chatPanel(page).getByTestId("chat-assistant")).toHaveText(["Tell me the new time."]);
  const sent = llm.requests.at(-1);
  expect(sent?.messages.map((m) => m.role)).toEqual(["system", "user"]);
  expect(JSON.stringify(sent?.messages)).not.toContain("Book deep work");
  expect(JSON.stringify(sent?.messages)).not.toContain(pending);
  const kept = await panelOf();
  expect(kept.conversations).toHaveLength(1);
  expect(kept.conversationId).not.toBe(cid);

  // A second chat, then its delete: the picker offers the chat that is left,
  // and picking it shows its messages again.
  await chatPanel(page).getByRole("button", { name: "New chat" }).click();
  expect(await say(page, "Anything else today?")).toBe(200);
  await expect(chatPanel(page).getByTestId("chat-assistant")).toHaveText(["Nothing else today."]);
  expect((await panelOf()).conversations).toHaveLength(2);
  await chatPanel(page).getByRole("button", { name: "Delete chat" }).click();
  const second = page.waitForResponse(
    (r) => r.url().includes("/api/assistant/conversations/") && r.request().method() === "DELETE",
  );
  await chatPanel(page)
    .getByRole("alertdialog", { name: "Delete this chat" })
    .getByRole("button", { name: "Yes, delete" })
    .click();
  expect((await second).status()).toBe(200);
  await expect(chatPanel(page).getByTestId("chat-user")).toHaveCount(0);
  const picker = chatPanel(page).getByLabel("Conversation", { exact: true });
  await expect(picker.locator("option")).toHaveText([
    "New chat",
    kept.conversations[0]?.title ?? "",
  ]);
  await picker.selectOption(kept.conversationId as string);
  await expect(chatPanel(page).getByTestId("chat-user")).toHaveText([
    `${draft}make it 14:00 to 16:00`,
  ]);
  await expect(chatPanel(page).getByTestId("chat-assistant")).toHaveText(["Tell me the new time."]);

  // The staged change still applies.
  await chatPanel(page).getByRole("button", { name: "Close" }).click();
  await reviewAndApply(page);
  await expect(page.getByTestId("apply-summary")).toContainText("Applied 1");
  const made = await eventually(
    async () =>
      (await cal.events(at(W, "00:00"), at(addDays(W, 7), "00:00"))).filter(
        (e) => e.summary === "Deep work",
      ),
    (evs) => expect(evs).toHaveLength(1),
  );
  expect(made.map((e) => [local(e.start), local(e.end)])).toEqual([
    [`${tue} 13:00`, `${tue} 15:00`],
  ]);
  await expect(previewPanel(page).getByTestId("staged-change")).toHaveCount(0);
});
