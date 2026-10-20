# AI tool integrations: ChatGPT, Claude, Cursor and other MCP clients

Spec id: SPEC-INT-14
Evidence: E-0144 (ev_b623ed6c3580), E-0026 (ev_5eabb3a73eec), E-0145 (ev_cf71c6306d94), E-0027 (ev_4722d19a0861), E-0147 (ev_fe130e9030c3), E-0133 (ev_05d15af3feda), E-0002 (ev_9600795a7f87)
Status of evidence: public docs only

## Summary

The user connects an AI tool to Tempoloom through one MCP server (Model
Context Protocol). The AI tool can then read the schedule and answer at
once, and propose calendar changes in natural language. Every change first
goes into preview mode, where the user approves it.

## Concepts and inputs

### Scope and evidence

This spec covers how each client connects and what the user can do. The
MCP server's tools belong to `assistant-mcp-server.md`, and staged changes
belong to `assistant-preview-mode.md`.

### Fields

MCP server: one HTTP endpoint per Tempoloom instance. Proposed default URL:
`https://<instance host>/mcp`. It uses MCP over streamable HTTP.

Authorization: OAuth 2.1 with authorization code and PKCE, as the MCP
authorization spec requires. The consent page names the client and has an
"Allow access" button. The client gets a token for the signed-in Tempoloom
user. (Protocol details: Proposed; the evidence shows an OAuth flow with an
"Allow access" step.)

Tempoloom decision: the server publishes OAuth protected resource metadata
(RFC 9728) at `/.well-known/oauth-protected-resource/mcp` and authorization
server metadata (RFC 8414) at `/.well-known/oauth-authorization-server`; a 401
from `/mcp` names the resource metadata. Clients register themselves
(RFC 7591, `/oauth/register`, public clients only), at most 20 times per hour
from one address; when 1000 clients wait for a first consent, registration
pauses, and a client with no consent after 24 hours is deleted. A redirect URI
has no fragment and is one of: https; http on a loopback host (`localhost`,
`127.0.0.1`, `[::1]`); a private-use scheme in reverse-domain form (RFC 8252
7.1, for example `com.example.app:/callback`); or the scheme `cursor`, which
Cursor uses. Every other scheme is refused. The consent page is
`/oauth/authorize` in the web app; it may not be framed. It names the client
as "unverified" (the client chose the name), the host the answer goes to (the
scheme and host for an app scheme), and the registration date. Only the
signed-in owner in a session of their own can allow access or revoke it: a
delegate and an API key get 403. A request with an unknown client or an
unregistered redirect URI shows an error; any other bad request of a known
client shows an error with a "Return to <host>" link and is never redirected
without a click. A user who must sign in first (Google or CalDAV) comes back
to the same consent page. It needs the S256 PKCE method and has the one scope
`mcp`. Codes last 10 minutes and work once; access tokens last 1 hour; refresh
tokens last 30 days and rotate at each use; a second use of a rotated refresh
token revokes the grant. One grant per client and user; Revoke deletes it with
all its tokens, and so does deactivation of the user. A personal API key still
works as a bearer token.

Client grant record: client name, user, scopes, created_at, last_used_at.

Requirements on the user side: a Tempoloom account with a connected Google
Calendar or Outlook calendar, and a client that supports MCP.

Capability groups (from the reference's use-case table, same for all
clients):

| Group | Read or write | Example request |
|---|---|---|
| View schedule | read | "List my meetings for today." |
| Find meeting times | read, then write to book | "Suggest a 30-minute slot for me, Ana and Ben before Friday." |
| Create and manage events | write | "Push the Jamie check-in to Tuesday." |
| Respond to invitations | write | "Decline the budget sync." |
| Protect focus time | write | "Reserve 2 hours of deep work on Wednesday before noon." |
| Analyze schedule | read | "How many focus hours did I have last week?" |
| Work sessions on tasks | write | "Record 90 minutes on the onboarding guide." |
| Review and apply changes | read and write | "Show the staged changes before you apply them." |

## Behavior

### Shared rules

1. Every client connects to the same MCP server and sees the same data.
2. Read tools return data at once and change nothing.
3. Write tools do not change the calendar directly. They stage the change in
   preview mode (`assistant-preview-mode.md`). The user reviews the change,
   then applies, edits or discards it. Proposed default: the tool result includes a link to the
   preview in Tempoloom, and the client can call an apply tool after the
   user confirms in the chat.
4. Write tools respect hours sets and scheduling preferences.
5. Data from connected task integrations (for example Jira) is also
   available through the MCP server (`integrations-jira.md`).
6. Disconnecting a client removes only that client's access. The calendar
   connections in Tempoloom stay. To remove calendar access too, the user
   revokes it at the calendar provider (Google account security settings, or
   Microsoft account connected apps).
7. Events that Tempoloom created stay on the calendar after disconnect.
8. Proposed default: account settings list all client grants with a Revoke
   action.

### ChatGPT

9. The reference lists its own app in the ChatGPT app directory. The user
   searches for it, clicks Connect, and completes the OAuth flow. Apps need
   a paid ChatGPT plan. The admin of a ChatGPT workspace can allow the app
   for all members in advance.
10. A self-hosted instance cannot rely on a single published app. Proposed
    default: the user adds a custom connector in ChatGPT with the instance's
    MCP URL, where the ChatGPT plan allows it. The settings page shows the
    URL with a copy button.
11. Disconnect: in ChatGPT settings, apps or connected apps, Disconnect.

### Claude

12. Claude Desktop and the Claude web app: the user does these steps.
    1. Open Settings, then the connectors section.
    2. Add a custom connector and name it, for example "Tempoloom".
    3. Enter the MCP URL.
    4. Complete the OAuth flow in the browser.
    5. Grant the tool permissions in Claude.
13. Claude Code: the user runs `claude mcp add tempoloom -t http <MCP URL>`,
    restarts Claude Code, opens the MCP server list, selects the server,
    and authenticates in the browser. `claude mcp list` shows the server as
    connected. To reinstall, the user runs `claude mcp remove tempoloom` and
    adds it again.
14. Claude lets the user set each tool to auto-approve, needs approval, or
    blocked. The reference recommends "needs approval" for every tool that
    creates or changes events. This is a Claude feature; Tempoloom must give
    each tool a clear name, a description, and a read-only hint so that the
    client can show it.
15. Troubleshooting text on the settings page: use the same email in Claude
    and Tempoloom; check the URL; restart or refresh Claude; remove and add
    the connector; authenticate again.
16. Disconnect: in Claude's connectors settings, Disconnect or Remove.

### Cursor

17. The user opens Cursor settings, Tools & MCP, New MCP Server. Cursor opens
    `mcp.json`. The user adds this entry inside `mcpServers` (and keeps any
    other entries):

    ```json
    { "mcpServers": { "tempoloom": { "type": "http", "url": "<MCP URL>" } } }
    ```

18. After saving, the server appears in Cursor. The user clicks Connect and
    completes the OAuth flow in the browser.
19. Troubleshooting: check the URL and the JSON syntax, restart Cursor,
    authenticate again.
20. Disconnect: remove the server in Cursor settings, or delete the
    `tempoloom` entry from `mcp.json`.

### Other MCP clients

21. Any client that supports remote MCP servers with OAuth can use the same
    URL. Setup steps depend on the client.

## Outputs

- OAuth grants for AI clients.
- Read results (schedule, availability, analysis).
- Staged changes in preview mode; calendar changes only after the
  user applies them.

## Edge cases

1. The client's token expires: the client asks the user to authenticate
   again; no staged change is lost.
2. The user is signed in to Tempoloom with another email than in the
   client. Proposed default: the consent page shows which Tempoloom account
   it will connect, so that the user can switch.
3. Two clients stage changes at the same time: both go to preview mode;
   `assistant-preview-mode.md` decides how they combine.
4. The client calls a write tool while the user has no connected calendar:
   the tool returns an error that tells the user to connect a calendar.

## Observed API shapes

Not yet observed. The reference uses one MCP URL for all clients.

## Open questions

1. Which tools does the reference's MCP server expose, and which are
   read-only? (Group E.)
2. Can a client apply staged changes itself, or must the user apply them in
   the web app?
3. Which OAuth scopes does the reference request from AI clients?
4. Does the reference list AI client grants in its own settings?

## Acceptance tests

Common setup: Tempoloom user with a Google Calendar test account; a Claude
Code test install with network access to the instance.

1. Connect and read.
   - Action: run `claude mcp add tempoloom -t http <MCP URL>`; authenticate;
     ask "List my meetings for today."
   - Expected: `claude mcp list` shows the server as connected. The answer
     lists today's events that are in Google Calendar. No calendar change.
   - Reload: run `claude mcp list` again; still connected.
2. Write goes to preview mode.
   - Action: ask "Reserve 2 hours tomorrow before noon for deep work."
   - Expected: no new event in Google Calendar yet. Preview mode in
     Tempoloom shows one proposed 2-hour block tomorrow before noon.
   - Action: apply the change in Tempoloom.
   - Expected: a 2-hour focus event appears in Google Calendar tomorrow
     morning.
   - Reload: reload Google Calendar; the event remains.
3. Disconnect keeps calendar access.
   - Action: run `claude mcp remove tempoloom`.
   - Expected: the client can no longer call tools. The Tempoloom web app
     still syncs Google Calendar; the event from test 2 remains.
   - Reload: same after reload.
4. Cursor config.
   - Setup: Cursor test install.
   - Action: add the `tempoloom` entry to `mcp.json`; connect; ask "Which
     slots are open for me in the next 7 days?"
   - Expected: the answer lists free times that match Google Calendar.
   - Reload: restart Cursor; the server is still connected.
