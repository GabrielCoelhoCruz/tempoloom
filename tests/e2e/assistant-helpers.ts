// Steps for assistant chat (docs/specs/assistant-chat.md): the planner panel.
import type { Page } from "@playwright/test";
import { expect } from "./fixtures.ts";

export const chatPanel = (p: Page) => p.getByTestId("assistant-panel");

/** A proposal card in the chat whose summary contains `text`. */
export const proposal = (p: Page, text: string) =>
  chatPanel(p).getByTestId("chat-proposal").filter({ hasText: text });

export async function openAssistant(p: Page): Promise<void> {
  await p.getByRole("button", { name: "Assistant", exact: true }).click();
  await expect(chatPanel(p)).toBeVisible();
  // The panel has drawn its data: the log, a notice or the memory list.
  await expect(
    chatPanel(p).locator('[data-testid="assistant-log"], [data-testid="assistant-refusal"]'),
  ).toBeVisible();
}

/** Sends a message and waits for the server's answer; returns its HTTP status. */
export async function say(p: Page, text: string, timeout?: number): Promise<number> {
  await chatPanel(p).getByLabel("Message to the assistant").fill(text);
  const answer = p.waitForResponse(
    (r) => r.url().endsWith("/api/assistant/messages") && r.request().method() === "POST",
    ...(timeout ? [{ timeout }] : []),
  );
  await chatPanel(p).getByRole("button", { name: "Send" }).click();
  const status = (await answer).status();
  if (status === 200) await expect(chatPanel(p).getByTestId("chat-user").last()).toHaveText(text);
  return status;
}
