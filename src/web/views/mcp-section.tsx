// The MCP server on the Account page (docs/specs/assistant-mcp-server.md rules
// 1, 9, 10; integrations-ai-tools.md rules 6-8): the server URL, how AI tools
// sign in, what they may do here, and the AI tools connected with OAuth, each
// with a Revoke action.
import { useCallback, useEffect, useState } from "preact/hooks";
import { ApiError, api } from "../lib/api.ts";
import { toLocalInput } from "../lib/format.ts";
import { zone } from "../lib/state.ts";

interface Grant {
  id: string;
  client: string;
  createdAt: number;
  lastUsedAt: number | null;
  /** Where the client's sign-in returned to. */
  host: string;
}

const when = (t: number) => toLocalInput(zone(), t).replace("T", " ");

export function McpSection() {
  const [info, setInfo] = useState<{ url: string; writeEnabled: boolean } | null>(null);
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [revoking, setRevoking] = useState<Grant | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const loadGrants = useCallback(
    () => void api<Grant[]>("GET", "/api/oauth/grants").then(setGrants),
    [],
  );
  useEffect(() => {
    void api<{ url: string; writeEnabled: boolean }>("GET", "/api/mcp/info").then(setInfo);
    loadGrants();
  }, [loadGrants]);
  if (!info) return null;
  return (
    <section data-testid="mcp-section">
      <h2>AI tools (MCP)</h2>
      <p>
        Connect an AI tool that speaks the Model Context Protocol (ChatGPT, Claude, Cursor or
        another MCP client) with this server URL: <code>{info.url}</code>{" "}
        <button type="button" onClick={() => void navigator.clipboard.writeText(info.url)}>
          Copy
        </button>
      </p>
      <p class="status">
        The AI tool opens a Tempoloom page where you allow access. A tool without that sign-in can
        use an API key from the list above as the bearer token; delete the key to disconnect it.
      </p>
      <p class="status" data-testid="mcp-access">
        {info.writeEnabled
          ? "AI tools can read your schedule and stage changes in preview mode. Nothing changes on your calendar until you apply it in the planner."
          : "This server gives AI tools read-only access: they can read your schedule, but they cannot propose changes."}
      </p>
      <h3>Connected AI tools</h3>
      <div class="list" data-testid="oauth-grants">
        {grants?.length === 0 && <p class="status">No AI tool is connected with OAuth.</p>}
        {grants?.map((g) => (
          <div class="row" key={g.id} data-grant={g.client}>
            <span>
              {g.client}{" "}
              <span class="meta">
                · {g.host} · connected {when(g.createdAt)} ·{" "}
                {g.lastUsedAt === null ? "never used" : `last used ${when(g.lastUsedAt)}`}
              </span>
            </span>
            <div class="actions">
              <button type="button" class="danger" onClick={() => setRevoking(g)}>
                Revoke
              </button>
            </div>
          </div>
        ))}
      </div>
      {revokeError && (
        <p class="error" role="alert">
          {revokeError}
        </p>
      )}
      <p class="status">
        Revoking removes only that tool's access. Your calendars stay connected to Tempoloom, and
        events the tool made stay on your calendar.
      </p>
      {revoking && (
        <div class="dialog-backdrop">
          <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="revoke-title">
            <h2 id="revoke-title">Revoke access</h2>
            <p>
              Revoke the access of "{revoking.client}"? It can no longer read your schedule or stage
              changes until you connect it again.
            </p>
            <div class="actions">
              <button
                type="button"
                class="primary"
                onClick={() => {
                  const g = revoking;
                  setRevoking(null);
                  setRevokeError(null);
                  void api("DELETE", `/api/oauth/grants/${g.id}`)
                    .catch((err: unknown) =>
                      setRevokeError(
                        (err instanceof ApiError &&
                          (err.body as { message?: string } | undefined)?.message) ||
                          "The access was not revoked. Try again.",
                      ),
                    )
                    .then(loadGrants);
                }}
              >
                Revoke access
              </button>
              <button type="button" onClick={() => setRevoking(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
