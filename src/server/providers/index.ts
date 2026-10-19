import { account, credentialsOf, googleAccessToken } from "../accounts.ts";
import type { SecretBox } from "../crypto.ts";
import { all, type Db, one } from "../db.ts";
import { GoogleCalendarApi } from "../google/calendar.ts";
import type { OAuthClient } from "../google/oauth.ts";
import type { ServiceAccountKey } from "../google/service-account.ts";
import { CalDavProvider } from "./caldav.ts";
import { GoogleProvider } from "./google.ts";
import { IcsFeedProvider } from "./ics.ts";
import type { CalendarProvider } from "./types.ts";

export interface ProviderDeps {
  db: Db;
  box: SecretBox;
  oauth: OAuthClient | undefined;
  serviceKey: ServiceAccountKey | undefined;
  now: () => number;
}

export function providerFor(deps: ProviderDeps, accountId: string, zone: string): CalendarProvider {
  const row = account(deps.db, accountId);
  if (row.provider === "ics") return new IcsFeedProvider(row.external_id, zone, deps.now);
  if (row.provider === "caldav") {
    const creds = credentialsOf(deps.box, row);
    // An account attached through a team's calendar grant reads with the grant's account.
    const grant = row.grant_team_id
      ? one<{ server_url: string; username: string; password: string }>(
          deps.db,
          "SELECT server_url, username, password FROM calendar_grants WHERE team_id = ?",
          row.grant_team_id,
        )
      : undefined;
    return new CalDavProvider(
      {
        serverUrl: grant?.server_url ?? row.server_url ?? "",
        username: grant?.username ?? creds.username ?? "",
        password: grant ? deps.box.open(grant.password) : (creds.password ?? ""),
        email: row.email,
        ...(creds.homeUrl ? { homeUrl: creds.homeUrl } : {}),
        sharedUrls: all<{ url: string }>(
          deps.db,
          "SELECT url FROM shared_calendars WHERE account_id = ? ORDER BY url",
          accountId,
        ).map((r) => r.url),
      },
      zone,
      deps.now,
    );
  }
  const api = new GoogleCalendarApi({
    getAccessToken: () =>
      googleAccessToken(deps.db, deps.box, accountId, {
        oauth: deps.oauth,
        serviceKey: deps.serviceKey,
        now: deps.now(),
      }),
  });
  return new GoogleProvider(api, zone);
}

/** Caches one provider per account for the length of a sync run. */
export class ProviderPool {
  readonly #deps: ProviderDeps;
  readonly #zone: string;
  readonly #byAccount = new Map<string, CalendarProvider>();
  readonly #credentials = new Map<string, string | null>();

  constructor(deps: ProviderDeps, zone: string) {
    this.#deps = deps;
    this.#zone = zone;
  }

  get(accountId: string): CalendarProvider {
    let p = this.#byAccount.get(accountId);
    if (!p) {
      this.#credentials.set(
        accountId,
        one<{ credentials: string | null }>(
          this.#deps.db,
          "SELECT credentials FROM accounts WHERE id = ?",
          accountId,
        )?.credentials ?? null,
      );
      p = providerFor(this.#deps, accountId, this.#zone);
      this.#byAccount.set(accountId, p);
    }
    return p;
  }

  /** The stored credentials that the account's provider was built with. */
  credentialsOf(accountId: string): string | null | undefined {
    return this.#credentials.get(accountId);
  }
}
