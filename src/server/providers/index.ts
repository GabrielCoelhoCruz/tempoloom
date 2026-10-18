import { account, credentialsOf, googleAccessToken } from "../accounts.ts";
import type { SecretBox } from "../crypto.ts";
import type { Db } from "../db.ts";
import { GoogleCalendarApi } from "../google/calendar.ts";
import type { OAuthClient } from "../google/oauth.ts";
import type { ServiceAccountKey } from "../google/service-account.ts";
import { CalDavProvider } from "./caldav.ts";
import { GoogleProvider } from "./google.ts";
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
  if (row.provider === "caldav") {
    const creds = credentialsOf(deps.box, row);
    return new CalDavProvider(
      {
        serverUrl: row.server_url ?? "",
        username: creds.username ?? "",
        password: creds.password ?? "",
        email: row.email,
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

  constructor(deps: ProviderDeps, zone: string) {
    this.#deps = deps;
    this.#zone = zone;
  }

  get(accountId: string): CalendarProvider {
    let p = this.#byAccount.get(accountId);
    if (!p) {
      p = providerFor(this.#deps, accountId, this.#zone);
      this.#byAccount.set(accountId, p);
    }
    return p;
  }
}
