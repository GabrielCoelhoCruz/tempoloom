// Changes to the loopback Radicale users (scripts/caldav-server.sh), for tests
// where a stored CalDAV password stops working.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE = join(
  process.env.TEMPOLOOM_E2E_STATE ?? join(homedir(), ".local/state/tempoloom"),
  "radicale",
);

/** Sets a Radicale user's password (scripts/caldav-server.sh files); Radicale reads them on each request. */
export function setPassword(user: string, n: number, password: string): void {
  const users = join(STATE, "config/users");
  const lines = readFileSync(users, "utf8")
    .split("\n")
    .map((l) => (l.startsWith(`${user}:`) ? `${user}:${password}` : l));
  writeFileSync(users, lines.join("\n"));
  writeFileSync(join(STATE, `password${n}`), `${password}\n`);
}
