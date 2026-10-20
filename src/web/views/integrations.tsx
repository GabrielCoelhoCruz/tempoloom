// Settings > Integrations (docs/specs/integrations-overview.md rules 1, 2, 13;
// Outputs): one card per integration, grouped by category. An OAuth tool that
// this server has no client for shows "Not configured on this server" with
// Connect disabled; tools that work through API keys, the MCP server or team
// webhooks link to their settings. The Google Calendar card follows the
// server's Google client and the user's Google accounts.
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import { onLinkClick } from "../lib/router.ts";
import { me } from "../lib/state.ts";

type Category =
  | "Calendar"
  | "Communication"
  | "Developer"
  | "Tasks"
  | "Launcher"
  | "Automation platform"
  | "AI tools"
  | "Add-on";

interface Tool {
  name: string;
  category: Category;
  purpose: string;
  /** Where its settings are, for a tool that works on this server without a provider client. */
  settings?: string;
}

const TOOLS: Tool[] = [
  { name: "Google Calendar", category: "Calendar", purpose: "Two-way sync with Google calendars." },
  {
    name: "Outlook Calendar",
    category: "Calendar",
    purpose: "Two-way sync with Outlook calendars.",
  },
  { name: "Slack", category: "Communication", purpose: "Status sync and tasks from messages." },
  { name: "Zoom", category: "Communication", purpose: "Zoom links for meetings." },
  { name: "Gong", category: "Communication", purpose: "Recording settings for team meetings." },
  {
    name: "Webhooks",
    category: "Developer",
    purpose: "Booking events sent to your team's endpoints.",
    settings: "/team",
  },
  { name: "Google Tasks", category: "Tasks", purpose: "Import tasks from Google Tasks." },
  { name: "Todoist", category: "Tasks", purpose: "Import tasks from Todoist." },
  { name: "Asana", category: "Tasks", purpose: "Import tasks from Asana." },
  { name: "ClickUp", category: "Tasks", purpose: "Import tasks from ClickUp." },
  { name: "Jira", category: "Tasks", purpose: "Import issues from Jira." },
  { name: "Linear", category: "Tasks", purpose: "Import issues from Linear." },
  {
    name: "Raycast",
    category: "Launcher",
    purpose: "Tasks and events from the Raycast launcher, with an API key.",
    settings: "/account",
  },
  {
    name: "Zapier",
    category: "Automation platform",
    purpose: "Connect other apps through the API, with an API key.",
    settings: "/account",
  },
  {
    name: "AI tools",
    category: "AI tools",
    purpose: "ChatGPT, Claude, Cursor and other MCP clients.",
    settings: "/account",
  },
  {
    name: "Calendar add-on",
    category: "Add-on",
    purpose: "Tempoloom actions inside your calendar app.",
  },
];

const CATEGORIES: Category[] = [
  "Calendar",
  "Communication",
  "Developer",
  "Tasks",
  "Launcher",
  "Automation platform",
  "AI tools",
  "Add-on",
];

/** Rule 2: the server's support address, else the project's issue form. */
const ISSUE_FORM =
  "https://github.com/GabrielCoelhoCruz/tempoloom/issues/new?title=Integration%20request%3A%20";

function Card({ tool, google }: { tool: Tool; google: boolean }) {
  const accounts = (me.value?.accounts ?? []).filter((a) => a.provider === "google" && !a.viaGrant);
  let state: string;
  let detail: string | null = null;
  let action: ComponentChildren;
  if (tool.name === "Google Calendar" && google) {
    const ok = accounts.filter((a) => a.status === "ok");
    if (ok.length > 0) {
      state = "Connected";
      detail = ok.map((a) => a.email).join(", ");
      action = (
        <a class="button" href="/account" onClick={onLinkClick}>
          Settings
        </a>
      );
    } else if (accounts.length > 0) {
      state = "Needs attention";
      detail = accounts.map((a) => a.email).join(", ");
      action = (
        <a class="button" href="/account" onClick={onLinkClick}>
          Reconnect
        </a>
      );
    } else {
      state = "Not connected";
      action = (
        <a class="button primary" href="/auth/google/start">
          Connect
        </a>
      );
    }
  } else if (tool.settings) {
    state = "Available";
    action = (
      <a class="button" href={tool.settings} onClick={onLinkClick}>
        Settings
      </a>
    );
  } else {
    state = "Not configured on this server";
    action = (
      <button type="button" disabled>
        Connect
      </button>
    );
  }
  return (
    <div class="row" data-testid="integration-card" data-integration={tool.name}>
      <span>
        <h3>{tool.name}</h3>
        <span class="meta">{tool.purpose}</span>{" "}
        <span class="badge" data-testid="integration-state">
          {state}
        </span>
        {detail && (
          <span class="meta" data-testid="integration-account">
            {" "}
            {detail}
          </span>
        )}
      </span>
      <div class="actions">{action}</div>
    </div>
  );
}

export function Integrations() {
  const [google, setGoogle] = useState<boolean | null>(null);
  const [support, setSupport] = useState<string | null>(null);
  useEffect(() => {
    void api<{ google: boolean }>("GET", "/auth/methods").then((m) => setGoogle(m.google));
    void api<{ supportUrl: string | null }>("GET", "/api/help").then((h) =>
      setSupport(h.supportUrl),
    );
  }, []);
  if (google === null) return null;
  return (
    <div class="page" data-testid="integrations-page">
      <h1>Integrations</h1>
      <p class="meta">
        <a href="/settings" onClick={onLinkClick}>
          Settings
        </a>{" "}
        › Integrations
      </p>
      {CATEGORIES.map((category) => (
        <section key={category} data-testid="integration-group" data-category={category}>
          <h2>{category}</h2>
          <div class="list">
            {TOOLS.filter((t) => t.category === category).map((t) => (
              <Card key={t.name} tool={t} google={google} />
            ))}
          </div>
        </section>
      ))}
      <p>
        <a href={support ?? ISSUE_FORM} target="_blank" rel="noopener noreferrer">
          Suggest a tool
        </a>
      </p>
    </div>
  );
}
