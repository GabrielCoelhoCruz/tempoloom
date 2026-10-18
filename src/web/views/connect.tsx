// Shown to a user without a calendar of their own, for example after a
// single sign-on: connects a CalDAV calendar that Tempoloom can plan in.
import { useState } from "preact/hooks";
import { ApiError, api } from "../lib/api.ts";
import { loadMe } from "../lib/state.ts";

export function ConnectCalendar() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <form
      class="form"
      data-testid="connect-calendar"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget as HTMLFormElement);
        setPending(true);
        setError(null);
        try {
          await api("POST", "/api/accounts", {
            serverUrl: f.get("serverUrl"),
            username: f.get("username"),
            password: f.get("password"),
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          });
          await loadMe();
        } catch (err) {
          const code =
            err instanceof ApiError ? (err.body as { error?: string } | undefined)?.error : "";
          setError(
            code === "invalid_credentials"
              ? "The server rejected the user name or password."
              : code === "no_calendars"
                ? "This account has no calendars."
                : code === "account_in_use"
                  ? "Another Tempoloom user already connected this account."
                  : "Could not reach the CalDAV server.",
          );
        } finally {
          setPending(false);
        }
      }}
    >
      <p class="wide">Connect a calendar so Tempoloom can plan in it.</p>
      <label>
        CalDAV server URL
        <input name="serverUrl" type="url" required placeholder="https://dav.example.com/" />
      </label>
      <label>
        User name
        <input name="username" required autocomplete="username" />
      </label>
      <label>
        Password
        <input name="password" type="password" required autocomplete="current-password" />
      </label>
      <button type="submit" class="primary" disabled={pending}>
        {pending ? "Connecting…" : "Connect calendar"}
      </button>
      {error && (
        <p class="error wide" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
