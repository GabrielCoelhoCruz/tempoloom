// Operator commands. Run with the same environment as the server.
//   node src/server/cli.ts login-link --email you@example.com
//   node src/server/cli.ts connect-google-service-account --email you@example.com [--calendar ID]
//   node src/server/cli.ts seat-limit --email admin@example.com --seats 10|none
//   node src/server/cli.ts limit [--name max_mirrors --value 3|none]
//   node src/server/cli.ts booking-reminders [--now 2026-10-20T08:00:00Z]
//   node src/server/cli.ts weekly-reports [--now 2026-10-23T08:30:00Z]
import { parseArgs } from "node:util";
import { createLoginLink, ensureUser, upsertAccount } from "./accounts.ts";
import { sendDueReminders } from "./booking-mail.ts";
import { clockOf, loadConfig } from "./config.ts";
import { SecretBox } from "./crypto.ts";
import { DailyMailWorker } from "./daily-mail.ts";
import { one, openDb, run } from "./db.ts";
import { parseServiceAccountKey } from "./google/service-account.ts";
import { instanceLimit, LIMITS, type LimitName, setInstanceLimit } from "./limits.ts";
import { createMailer } from "./mail.ts";

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    email: { type: "string" },
    name: { type: "string" },
    seats: { type: "string" },
    value: { type: "string" },
    now: { type: "string" },
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
  const at = values.now ? Date.parse(values.now) : clockOf(config)();
  if (Number.isNaN(at)) throw new Error("--now must be an ISO date and time");
  const worker = new DailyMailWorker({
    db,
    mailer: createMailer(config.SMTP_URL, config.MAIL_FROM),
    now: () => at,
    baseUrl: config.BASE_URL,
    intervalMs: 60_000,
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
    const key = parseServiceAccountKey(config.GOOGLE_SERVICE_ACCOUNT_JSON);
    const user = ensureUser(db, email, values.name ?? email);
    const id = upsertAccount(db, box, {
      userId: user.id,
      provider: "google_service",
      externalId: key.client_email,
      email: key.client_email,
      credentials: {},
    });
    console.log(`account ${id} for user ${user.id}`);
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
