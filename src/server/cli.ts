// Operator commands. Run with the same environment as the server.
//   node src/server/cli.ts login-link --email you@example.com
//   node src/server/cli.ts connect-google-service-account --email you@example.com [--calendar ID]
import { parseArgs } from "node:util";
import { createLoginLink, ensureUser, upsertAccount } from "./accounts.ts";
import { loadConfig } from "./config.ts";
import { SecretBox } from "./crypto.ts";
import { openDb } from "./db.ts";
import { parseServiceAccountKey } from "./google/service-account.ts";

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: { email: { type: "string" }, name: { type: "string" } },
});
const config = loadConfig();
const db = openDb(config.dbPath);
const box = new SecretBox(config.SECRET_KEY);
const email = values.email;
if (!email) throw new Error("--email is required");

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
  default:
    throw new Error(`Unknown command: ${command ?? "(none)"}`);
}
db.close();
