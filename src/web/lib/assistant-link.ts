// The daily digest links to the planner with ?assistant=<conversation>
// (assistant-chat.md rule 18). A signed-out reader signs in first, through
// Google or a single sign-on provider that comes back to "/": the id waits in
// sessionStorage (this tab only) until the planner opens the chat with it.
const KEY = "tl-assistant-link";

/** On the sign-in page: keep the link's conversation for after the sign-in. */
export function keepAssistantLink(): void {
  const id = new URLSearchParams(location.search).get("assistant");
  if (id) sessionStorage.setItem(KEY, id);
}

/** The conversation of a digest link, from the URL or kept over a sign-in. */
export function hasAssistantLink(): boolean {
  return (
    new URLSearchParams(location.search).has("assistant") || sessionStorage.getItem(KEY) !== null
  );
}

/** Takes the conversation id once: removes it from the URL and from sessionStorage. */
export function takeAssistantLink(): string | null {
  const params = new URLSearchParams(location.search);
  const id = params.get("assistant") ?? sessionStorage.getItem(KEY);
  sessionStorage.removeItem(KEY);
  if (params.has("assistant")) {
    params.delete("assistant");
    const q = params.toString();
    history.replaceState(history.state, "", `${location.pathname}${q ? `?${q}` : ""}`);
  }
  return id;
}
