// The MCP server on the Account page (docs/specs/assistant-mcp-server.md rules
// 1, 9, 10): the server URL, how to authenticate, and what AI tools may do here.
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.ts";

export function McpSection() {
  const [info, setInfo] = useState<{ url: string; writeEnabled: boolean } | null>(null);
  useEffect(() => {
    void api<{ url: string; writeEnabled: boolean }>("GET", "/api/mcp/info").then(setInfo);
  }, []);
  if (!info) return null;
  return (
    <section data-testid="mcp-section">
      <h2>AI tools (MCP)</h2>
      <p>
        Connect an AI tool that speaks the Model Context Protocol with this server URL:{" "}
        <code>{info.url}</code>
      </p>
      <p class="status">
        As the bearer token, give the tool an API key from the list above. The list shows when a
        tool last used its key. Delete the key to disconnect the tool.
      </p>
      <p class="status" data-testid="mcp-access">
        {info.writeEnabled
          ? "AI tools can read your schedule and stage changes in preview mode. Nothing changes on your calendar until you apply it in the planner."
          : "This server gives AI tools read-only access: they can read your schedule, but they cannot propose changes."}
      </p>
    </section>
  );
}
