# Integrations: directory and connection lifecycle

Spec id: SPEC-INT-01
Evidence: E-0002 (ev_9600795a7f87), E-0029 (ev_2cd9b977c6e8), E-0033 (ev_448e7d295296), E-0153 (ev_74bd257356a8), E-0154 (ev_80048adfa431), E-0143 (ev_8cd26d7dd2ad), E-0146 (ev_97c8101e3db1), E-0149 (ev_d29fa94e9488), E-0151 (ev_1f3ad2991e11), E-0156 (ev_20ff2ded5fee), E-0152 (ev_15215a75fbbb), E-0080 (ev_e7c9f46f0550)
Status of evidence: public docs only

## Summary

The integrations page lists every third-party tool that Tempoloom can
connect to. Each integration has a card with a state and with connect,
settings and disconnect actions. This spec defines the lifecycle that all
integrations share. Each integration spec (`integrations-*.md`) adds its own
behavior and refers back to this spec.

## Concepts and inputs

Integration kinds and their spec:

| Kind | Category | Spec | Owner of the connection |
|---|---|---|---|
| Google Calendar | Calendar | `accounts-connected-calendars.md` (group D) | user |
| Outlook Calendar | Calendar | `accounts-outlook-support.md` (group D) | user |
| Slack | Communication | `integrations-slack.md` | user (per Slack workspace) |
| Zoom | Communication | `integrations-video-conferencing.md` | user |
| Gong | Communication | `integrations-video-conferencing.md` | team |
| Webhooks | Developer | `integrations-webhooks.md` | team |
| Google Tasks | Tasks | `integrations-google-tasks.md` | user |
| Todoist | Tasks | `integrations-todoist.md` | user |
| Asana | Tasks | `integrations-asana.md` | user |
| ClickUp | Tasks | `integrations-clickup.md` | user |
| Jira | Tasks | `integrations-jira.md` | user |
| Linear | Tasks | `integrations-linear.md` | user |
| Raycast | Launcher | `integrations-raycast.md` | user (client) |
| Zapier | Automation platform | `integrations-api-keys-zapier.md` | user (client) |
| AI tools (ChatGPT, Claude, Cursor, other MCP clients) | AI tools | `integrations-ai-tools.md` | user (client) |
| Calendar add-on | Add-on | `integrations-calendar-add-on.md` | user (client) |

Connection record (one per owner and external account):

| Field | Type | Notes |
|---|---|---|
| `kind` | enum | One value from the table above. |
| `owner` | user id or team id | See the owner column. |
| `external_account_id` | string | Provider user, workspace or site id. |
| `external_account_label` | string | Email, workspace name or site name that the card shows. |
| `status` | enum | `active`, `needs_reauth`, `suspended`, `disconnected`. |
| `scopes` | list of strings | Provider scopes that the user granted. |
| `created_at`, `last_sync_at` | timestamp | |
| `last_error` | string or null | Short text that the card shows. |

Directory entry (static data that the card shows): name, one-line purpose,
category, plan requirement, supported calendar providers, and a "what syncs"
list. In the reference, Google Tasks supports only Google Calendar. All other
non-calendar integrations support Google Calendar and Outlook Calendar.

## Behavior

1. The user opens Settings > Integrations. The page shows one card for each
   integration in the table above, grouped by category.
2. The page has a "Suggest a tool" link at the end. It opens a contact form
   or a mail link. The reference has a similar request link.
3. A card in state "not connected" shows a Connect button. Connect starts the
   provider's OAuth consent flow in the same browser tab.
4. When the provider has several workspaces, sites or organizations for the
   user, the consent flow lets the user choose one. Asana, ClickUp, Jira,
   Linear and Slack have this choice.
5. After consent, the browser returns to the integration's settings page in
   Tempoloom. The card shows "connected" and the external account label.
6. When the provider workspace requires admin approval for third-party
   apps, the provider blocks the consent. Tempoloom shows the provider's
   error and the text "An admin of this workspace must approve the app."
   (Proposed default for the text.)
7. Some integrations need a second consent step for AI tool access (the
   reference shows this for ClickUp). Tempoloom shows the second step only
   when the integration data is also exposed to the MCP server
   (`integrations-ai-tools.md`).
8. A card in state "connected" shows Settings and Disconnect actions.
   Disconnect asks for confirmation. After confirmation:
   - Tempoloom stops all future reads and writes for that connection.
   - Tempoloom deletes the stored provider tokens.
   - Managed events that already exist stay on the calendar.
   - Data in the external app stays in the external app.
   - Each integration spec states what else stops.
9. The user can also remove the Tempoloom app from the provider side. When a
   provider call fails because access was revoked, or the provider sends an
   uninstall event, Tempoloom sets the connection to `disconnected` and
   shows it on the card. The reference detects this with a periodic
   background check. For Google Tasks (legacy evidence) the check runs about
   every 5 to 10 minutes.
10. When a token refresh fails for another reason, Tempoloom sets the
    connection to `needs_reauth`. The card shows a Reconnect button. Sync
    stops. Tempoloom deletes no data.
11. The user must connect the external account that holds the data. For
    Google Tasks the reference advises the same Google account as the
    calendar. Tempoloom shows the connected account label on the card so
    that the user can check it.
12. Plan gating: the reference makes most integrations available only on
    paid plans (see Notes in the parity table). Tempoloom is self-hosted, so
    plan gating is out of scope unless `plans-feature-inventory.md` adds it.
13. Self-hosting: each OAuth integration needs client credentials that the
    instance operator registers with the provider. When the operator has not
    configured them, the card shows "Not configured on this server" and
    Connect is disabled. (Proposed default.)
    Tempoloom decision: a tool that Tempoloom does not build yet (no server
    setting can turn it on) shows "Not available yet" with Connect disabled;
    "Not configured on this server" is for a built tool without the
    operator's client, today Google Calendar. The Google Calendar card offers
    no Connect to a user without a Google account: Google sign-in would sign
    in as another Tempoloom user, and adding a Google account to a user who
    signed in another way is not built yet.

Calendar provider cards (Google Calendar, Outlook Calendar) appear in the
directory. Their behavior belongs to `accounts-connected-calendars.md`,
`accounts-outlook-support.md` and `sync-calendar-mirroring.md` (group D).
The reference pages list: two-way sync, more than one account, personal
events copied as private busy blocks, Meet and Teams links, colors and
categories, and admin pre-approval. This spec only requires the two cards.

## Outputs

- Integrations page with cards. Card states: not connected, connected
  (with account label), needs attention (with Reconnect), not configured on
  this server.
- No calendar events are created or changed by connect or disconnect.

## Edge cases

1. The user starts consent and cancels on the provider page. The card stays
   "not connected" and shows no error.
2. The user connects an account that is already connected to another
   Tempoloom user. Proposed default: allow it; each Tempoloom user has an
   independent connection.
3. The user connects a second external account for an integration that
   supports only one. Proposed default: Tempoloom asks to replace the first
   connection.
4. The user disconnects while a sync run is in progress. The run stops
   before its next write. No partial write is left for the next run.
5. A workspace admin removes the app for the whole workspace. All
   connections that use that workspace change to `disconnected`.
6. The provider is down. The connection stays `active`. Tempoloom retries
   with backoff and shows `last_error` on the card after 3 failed runs.
   (Proposed default.)

## Observed API shapes

Not yet observed.

## Open questions

1. After disconnect, do imported tasks stay as plain tasks, or does the
   reference delete them? Its docs only say that tasks and events "may
   remain". Proposed default: imported tasks stay as local tasks with the
   source link marked "disconnected".
2. Does the reference list connected client apps (Raycast, AI tools) with a
   revoke action? Its Raycast page mentions this only as "if available".
3. Which integrations does each reference plan include? Group E builds the
   plan inventory.

## Acceptance tests

1. Connect and disconnect a task integration.
   - Setup: Tempoloom user with a Google Calendar test account. Todoist test
     account with one task that meets the import rules
     (`integrations-todoist.md`).
   - Action: connect Todoist from Settings > Integrations. Wait for the
     chunks of the imported task to appear. Disconnect Todoist and confirm.
   - Expected: after connect, the card shows the Todoist account label and
     the chunks appear in Google Calendar. After disconnect, the card shows
     "not connected" and the chunks are still in Google Calendar.
   - Reload: reload the integrations page and Google Calendar. The states do
     not change. A new Todoist task created after disconnect does not
     import within 10 minutes.
2. Revoke from the provider side.
   - Setup: connected Todoist integration.
   - Action: revoke the Tempoloom app in Todoist settings.
   - Expected: within 10 minutes, the card shows "not connected" or
     "needs attention". Existing chunks stay in Google Calendar.
   - Reload: reload the integrations page. The state is still shown.
3. Integration not configured by the operator.
   - Setup: start an instance without Slack client credentials.
   - Action: open Settings > Integrations.
   - Expected: the Slack card shows "Not configured on this server" and
     Connect is disabled. No calendar change.
   - Reload: the card state is the same after reload.
