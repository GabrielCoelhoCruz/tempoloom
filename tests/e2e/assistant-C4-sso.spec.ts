// The daily digest's link (?assistant=<conversation>, assistant-chat.md rule
// 18) for a reader who is signed out and signs in through single sign-on (a
// real Dex identity provider, tests/e2e/sso-fixtures.ts). The identity
// provider comes back to "/", so the link must survive the round trip.
//
// Ways this can fail:
// - the sign-in drops the conversation, and the planner opens without the chat
//   or on the newest conversation instead of the linked one.

import { chatPanel } from "./assistant-helpers.ts";
import { BACKEND, EMAIL } from "./fixtures.ts";
import { expect, test } from "./sso-fixtures.ts";
import { openTeam } from "./team-helpers.ts";

test.skip(BACKEND === "google", "The identity provider runs on loopback with the CalDAV suite.");

test("a digest link keeps its conversation through single sign-on: after the identity provider's page the planner opens the chat on that conversation (assistant-chat rule 18)", async ({
  page,
  app,
  signIn,
  idp,
  llm,
}) => {
  await signIn();
  app.cli("seat-limit", "--email", EMAIL, "--seats", "5");
  await openTeam(page);
  const sso = page.getByTestId("sso");
  await sso.getByLabel("Email domains").fill(idp.email("u").split("@")[1] ?? "");
  await sso.getByLabel("Issuer URL").fill(idp.issuer);
  await sso.getByLabel("Client ID").fill(idp.clientId);
  await sso.getByLabel("Client secret").fill(idp.clientSecret);
  await sso.getByRole("button", { name: "Save single sign-on" }).click();
  await expect(sso.getByTestId("sso-saved")).toBeVisible();

  // U has two conversations; the link names the older one.
  llm.on(/topic/i, [{ content: "Noted." }]);
  const pu = await idp.signIn("u");
  const ids = await pu.evaluate(async () => {
    const send = async (text: string) => {
      const r = await fetch("/api/assistant/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, conversationId: null }),
      });
      return ((await r.json()) as { conversationId: string }).conversationId;
    };
    return [await send("First topic"), await send("Second topic")];
  });
  expect(ids[0]).not.toBe(ids[1]);
  await pu.context().close();

  // Signed out (a new browser), U opens the link and signs in through the identity provider.
  const back = await idp.signIn("u", `/?assistant=${ids[0]}`);
  await expect(chatPanel(back)).toBeVisible();
  await expect(chatPanel(back).getByTestId("chat-user")).toHaveText(["First topic"]);
  await expect(back).not.toHaveURL(/assistant=/);
  // The link is used once: a reload shows the planner without opening the chat again.
  await back.reload();
  await expect(back.getByTestId("app-shell")).toBeVisible();
  await expect(chatPanel(back)).toHaveCount(0);
});
