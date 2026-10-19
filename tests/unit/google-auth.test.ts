// A Google account whose login stops working (accounts-login-emails-permissions.md
// rules 14-16), against a fake Google Calendar API.
//
// Ways it can fail:
// 1. One 401 (an access token that Google dropped before its expiry) ends in a
//    disconnect: the client must get a new access token and try once more.
// 2. A refresh token that Google revoked (OAuth invalid_grant) or an account
//    already marked for a new login aborts the user's whole sync run, instead
//    of a provider auth error that disconnects only that account.
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleCalendarApi } from "../../src/server/google/calendar.ts";
import { OAuthError } from "../../src/server/google/oauth.ts";
import { GoogleProvider } from "../../src/server/providers/google.ts";
import { ProviderError } from "../../src/server/providers/types.ts";

afterEach(() => vi.unstubAllGlobals());

/** Google answers 401 to the stale token and lists one calendar for the fresh one. */
function fakeGoogle() {
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (_url: URL, init: RequestInit) => {
    const auth = (init.headers as Record<string, string>).authorization ?? "";
    seen.push(auth);
    return auth === "Bearer fresh"
      ? Response.json({ items: [{ id: "cal", summary: "Cal", accessRole: "owner" }] })
      : Response.json({ error: { code: 401, message: "Invalid Credentials" } }, { status: 401 });
  });
  return seen;
}

describe("Google login errors", () => {
  it("gets a new access token and tries once more after a 401", async () => {
    const seen = fakeGoogle();
    const api = new GoogleCalendarApi({
      getAccessToken: async (fresh?: boolean) => (fresh ? "fresh" : "stale"),
      sleep: async () => {},
    });
    const list = await new GoogleProvider(api, "UTC").listCalendars();
    expect(list.map((c) => c.id)).toEqual(["cal"]);
    expect(seen).toEqual(["Bearer stale", "Bearer fresh"]);
  });

  it("gives an auth error when the new access token is refused too", async () => {
    const seen = fakeGoogle();
    const api = new GoogleCalendarApi({
      getAccessToken: async () => "stale",
      sleep: async () => {},
    });
    const err = await new GoogleProvider(api, "UTC").listCalendars().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("auth");
    expect(seen).toHaveLength(2);
  });

  it.each(["invalid_grant", "reauth_required"])(
    "maps the OAuth error %s to a provider auth error",
    async (code) => {
      fakeGoogle();
      const api = new GoogleCalendarApi({
        getAccessToken: async () => {
          throw new OAuthError(code, "refused");
        },
      });
      const err = await new GoogleProvider(api, "UTC").listCalendars().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).kind).toBe("auth");
    },
  );
});
