# Tempoloom

Tempoloom is a self-hostable calendar planner. You give it tasks, habits and
focus-time goals. It finds time for them around your meetings, writes the
blocks into your calendar (Google Calendar or any CalDAV server), and moves
them when your week changes.

Status: early development. See [docs/parity.md](docs/parity.md) for the
feature list and the status of each feature.

## Features

- Tasks with priorities, due dates and chunks; habits; focus-time goals;
  buffers (recovery, prep, travel and airport time); breaks between items.
- Flexible meetings: recurring meetings with people on the same instance.
  Tempoloom finds a time inside everyone's meeting hours and moves it when
  someone becomes busy.
- Booking links with a public booking page, reschedule and cancel, and signed
  webhooks.
- Calendar mirroring between calendars.
- Event categories and colors.
- Personal stats, an automation library, a meeting cost calculator and a
  pomodoro timer.
- Teams: invitations by email or link, join requests, roles and seat limits;
  defaults and habit templates for new members; shared out-of-office
  calendars; team no-meeting days.
- Team booking links (all organizers free) and round-robin links, a team
  directory of booking pages, branding, and team webhooks.
- Delegated access for assistants, personal API keys, and live updates when
  two people work in one account.
- Team and organization analytics with CSV export; team policies for focus
  time, buffers, meeting agendas and calendar fragmentation.
- Single sign-on (OpenID Connect), domain capture, directory provisioning
  (SCIM 2.0) and organization-wide calendar access for CalDAV servers.
- An Automations page lists habits, focus time, buffers, flexible meetings,
  meeting overload and meeting checks by priority. Drag to rank, filter by
  type, turn off or remove; a Create menu sits in the top bar.
- Event settings for habits, focus time and buffers: emoji, category and
  color, visibility, target calendar, location, description and reminders.
  Title markers show done, partly done, travel, flight and personal copies.
- Habits: make one from a recurring event, reschedule one occurrence, edit
  from any event, monthly habits. Focus time: proactive or reactive mode,
  auto-decline with a message, weekly progress. Meeting overload: daily and
  weekly meeting limits. Saved task searches on habits and focus time.
- Buffer filters from a plain-language description, with a live list of
  matching events, by person, by calendar, and after a run of meetings.
- Tasks as suggestions only, with Suggested now and At risk lists, the
  next-up task and work blocks on request. A timer on tasks and habits logs
  time that stats count.
- Travel time zones with dates; hours, habits and booking links follow them.
  Hours: replacement on delete, item-specific hours for habits, a preview in
  item forms, a first-run review and a check for a wrong browser zone.
- The planner shows the next meeting with a join link, flags overlapping
  meetings, and gives a tab alert and a chime at event start. Event notes
  support markdown and link back to the item.
- Meeting checks (overlaps, declines, unanswered invitations, missing video
  links) in an Issues tab, with ignore, a daily email digest and company
  checks for team admins; recommendations beside them.
- Flexible meetings can take over an existing recurring meeting, move when a
  required guest declines, follow a daily move limit, keep a change log per
  occurrence and email guests about changes. Start-time intervals and a
  weekly no-meeting day.
- Booking links: screening questions, redirect after booking, emails on
  booking, reschedule, cancel and before the meeting, an availability
  inspector, a time zone picker, 12- or 24-hour times, URL parameters, a
  calendar overlay for signed-in bookers, link groups, one-off links, shared
  times, a share menu and website embeds.
- Calendar mirroring: a policy list per account, edits after creation,
  labels by category, a color per policy, copies that never alert, a full
  check twice a day and copies 12 months ahead. Connected calendars: a
  category per calendar, calendars shared by URL, holiday feeds.
- Several calendar accounts per person: sign in with any of them and change
  the main email.
- Preview mode stages changes from AI tools, automation edits and planner
  drags until you apply them. An MCP server at `/mcp` lets any MCP client
  read the schedule and propose changes, with a personal API key.
- Help pages with an event lookup and Tempoloom's own change log; stats for
  deep and shallow work, breaks, travel, time away, people met, insights and
  planned versus actual time.

## Goals

- Fast: small client bundle, low interaction latency, and a scheduler that
  plans a full week in milliseconds. Measurements: [docs/performance.md](docs/performance.md).
- Self-hostable: one Node.js process and one SQLite file.
- Deterministic: the same input always gives the same schedule.
- Open: AGPL-3.0.

## Requirements

- Node.js 24.11 or later
- For Google sign-in: a Google Cloud OAuth client (type "Web application")
  with the redirect URI `<BASE_URL>/auth/google/callback`. Without it, users
  sign in with a CalDAV server.

## Run it

```bash
npm ci
npm run build
export SECRET_KEY="$(openssl rand -base64 32)"   # keep this value; it encrypts tokens
export GOOGLE_CLIENT_ID=...
export GOOGLE_CLIENT_SECRET=...
export BASE_URL=http://localhost:8787
npm start
```

Open `BASE_URL` and sign in with Google or with a CalDAV account.

Behind a reverse proxy or tunnel (for example for the https URL that remote
AI tool connectors need), set `TRUSTED_PROXIES` to the proxy's addresses,
comma-separated, for example `TRUSTED_PROXIES=127.0.0.1,::1`. Only for a
request from one of these addresses does Tempoloom read the client address
from `X-Forwarded-For`; it takes the rightmost address that is not a trusted
proxy. Without it, every request has the proxy's address, and limits per
address (AI tool registration: 20 per hour, IPv6 counted per /64) apply to the
whole server. Do not list an address that clients can reach directly.

Webhooks go only to public `https` hosts. To send them to a receiver on a
private network, set `WEBHOOK_ALLOW_PRIVATE=true`.

Mail (invitations, booking and meeting emails, daily digests) needs
`SMTP_URL`. Other settings are in `.env.example`. Tempoloom has no paid
tiers; an operator can set limits per server with the CLI, all off by default:

```bash
node src/server/cli.ts limit --name max_connected_calendars --value 5   # or none
node src/server/cli.ts booking-reminders                              # send due reminders now
```

Limit names: `max_scheduling_window_weeks`, `max_connected_calendars`,
`max_mirrors`, `max_booking_links`, `max_automations_per_user`.

### With Docker

```bash
cp .env.example .env    # fill in the values
docker compose up -d
```

The database lives in the `tempoloom-data` volume. Back up that volume and
keep `SECRET_KEY`: without it, the stored Google tokens cannot be read.

## Develop

```bash
npm run typecheck
npm run lint
npm test            # scheduler and unit tests
npm run test:e2e    # end-to-end tests; see tests/e2e/README.md
```

Design decisions are in [docs/adr](docs/adr). Feature behavior is defined in
[docs/specs](docs/specs). Code is written from those specs; see
[docs/clean-room.md](docs/clean-room.md).

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
