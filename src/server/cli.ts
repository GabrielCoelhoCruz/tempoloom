// Operator commands. Run with the same environment as the server.
//   node src/server/cli.ts login-link --email you@example.com
//   node src/server/cli.ts connect-google-service-account --email you@example.com [--calendar ID]
//   GOOGLE_REFRESH_TOKEN=... node src/server/cli.ts connect-google-oauth --email you@example.com [--calendar ID]
//     (needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, the client that got the token)
//   node src/server/cli.ts seat-limit --email admin@example.com --seats 10|none
//   node src/server/cli.ts limit [--name max_mirrors --value 3|none]
//   node src/server/cli.ts booking-reminders [--now 2026-10-20T08:00:00Z]
//   node src/server/cli.ts weekly-reports [--now 2026-10-23T08:30:00Z]   (--now: TEMPOLOOM_TEST_MODE=1 only)
import { parseArgs } from "node:util";
import { createLoginLink, ensureUser } from "./accounts.ts";
import { createAppWithChat, NO_SYNC } from "./app.ts";
import { sendDueReminders } from "./booking-mail.ts";
import { clockOf, loadConfig } from "./config.ts";
import { SecretBox } from "./crypto.ts";
import { DailyMailWorker, dailyReview } from "./daily-mail.ts";
import { one, openDb, run } from "./db.ts";
import { connectGoogleOauth, connectGoogleServiceAccount } from "./google/connect.ts";
import { parseServiceAccountKey } from "./google/service-account.ts";
import { instanceLimit, LIMITS, type LimitName, setInstanceLimit } from "./limits.ts";
import { createMailer } from "./mail.ts";
import { WebhookWorker } from "./webhooks.ts";

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    email: { type: "string" },
    name: { type: "string" },
    seats: { type: "string" },
    value: { type: "string" },
    now: { type: "string" },
    calendar: { type: "string" },
  },
});
const config = loadConfig();
const db = openDb(config.dbPath);
const box = new SecretBox(config.SECRET_KEY);
if (command === "booking-reminders") {
  // Sends the booking reminders due at --now (default: the server clock), as the server does each minute.
  const at = values.now ? Date.parse(values.now) : clockOf(config)();
  if (Number.isNaN(at)) throw new Error("--now must be an ISO date and time");
  const mailer = createMailer(config.SMTP_URL, config.MAIL_FROM);
  const n = await sendDueReminders(db, mailer, config.BASE_URL, at);
  console.log(`sent ${n} reminder${n === 1 ? "" : "s"}`);
  db.close();
  process.exit(0);
}
if (command === "weekly-reports") {
  // One run of the server's email worker at --now (default: the server clock):
  // the weekly reports due then, and the other daily emails due then.
  // --now is for tests only: at a moved instant the run also sends the other
  // emails due then and moves their next send time, which a real server must not do.
  if (values.now && !config.TEMPOLOOM_TEST_MODE)
    throw new Error("--now needs TEMPOLOOM_TEST_MODE=1 (tests only)");
  const at = values.now ? Date.parse(values.now) : clockOf(config)();
  if (Number.isNaN(at)) throw new Error("--now must be an ISO date and time");
  const mailer = createMailer(config.SMTP_URL, config.MAIL_FROM);
  // The daily review uses the app's assistant chat, as in the server. This app
  // only reads and stages; the server syncs and sends webhooks (not started here).
  const { chat } = createAppWithChat({
    db,
    config,
    box,
    oauth: undefined,
    sync: NO_SYNC,
    webhooks: new WebhookWorker({
      db,
      box,
      allowPrivate: config.WEBHOOK_ALLOW_PRIVATE,
      retryBaseMs: config.WEBHOOK_RETRY_BASE_MS,
      suspendAfterMs: config.WEBHOOK_SUSPEND_AFTER_SECONDS * 1000,
      mailer,
      baseUrl: config.BASE_URL,
      now: () => at,
    }),
    mailer,
    now: () => at,
  });
  const worker = new DailyMailWorker({
    db,
    mailer,
    now: () => at,
    baseUrl: config.BASE_URL,
    intervalMs: 60_000,
    review: dailyReview(config, chat),
  });
  const n = await worker.tick();
  console.log(`sent ${n} report${n === 1 ? "" : "s"}`);
  db.close();
  process.exit(0);
}
const email = values.email ?? "";
if (!email && command !== "limit") throw new Error("--email is required");

switch (command) {
  case "login-link": {
    const user = ensureUser(db, email, values.name ?? email);
    console.log(new URL(`/auth/link/${createLoginLink(db, user.id)}`, config.BASE_URL).toString());
    break;
  }
  case "connect-google-service-account": {
    if (!config.GOOGLE_SERVICE_ACCOUNT_JSON)
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set");
    // The service account's own calendar list has no meaningful primary, so the
    // operator names the calendar to plan on; the next sync keeps it as primary.
    const key = parseServiceAccountKey(config.GOOGLE_SERVICE_ACCOUNT_JSON);
    const c = await connectGoogleServiceAccount(db, box, key, target());
    console.log(`account ${c.accountId} for user ${c.userId}`);
    break;
  }
  case "connect-google-oauth": {
    // For a server with no browser: the refresh token comes from a consent done elsewhere.
    const client =
      config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET
        ? { clientId: config.GOOGLE_CLIENT_ID, clientSecret: config.GOOGLE_CLIENT_SECRET }
        : undefined;
    const c = await connectGoogleOauth(db, box, client, process.env.GOOGLE_REFRESH_TOKEN, target());
    console.log(`account ${c.accountId} for user ${c.userId}`);
    break;
  }
  case "seat-limit": {
    // The most members of the user's team (teams-membership.md rules 24-27).
    const seats = values.seats === "none" ? null : Number(values.seats);
    if (seats !== null && !(Number.isInteger(seats) && seats > 0))
      throw new Error("--seats must be a positive number or none");
    const team = one<{ team_id: string }>(
      db,
      "SELECT m.team_id FROM team_members m JOIN users u ON u.id = m.user_id WHERE u.email = ?",
      email.toLowerCase(),
    );
    if (!team) throw new Error(`No user ${email}`);
    run(db, "UPDATE teams SET seat_limit = ? WHERE id = ?", seats, team.team_id);
    console.log(`team ${team.team_id}: seat limit ${seats ?? "none"}`);
    break;
  }
  case "limit": {
    // Instance limits (plans-feature-inventory.md rule 2); without --name, prints them all.
    const name = values.name as LimitName | undefined;
    if (name !== undefined) {
      if (!LIMITS.includes(name)) throw new Error(`--name must be one of ${LIMITS.join(", ")}`);
      const value = values.value === "none" ? null : Number(values.value);
      if (value !== null && !(Number.isInteger(value) && value > 0))
        throw new Error("--value must be a positive number or none");
      setInstanceLimit(db, name, value);
    }
    for (const n of LIMITS) console.log(`${n}: ${instanceLimit(db, n) ?? "none"}`);
    break;
  }
  default:
    throw new Error(`Unknown command: ${command ?? "(none)"}`);
}
db.close();

function target() {
  return { email, name: values.name, calendar: values.calendar };
}
