// The sign-in page: Google, single sign-on and CalDAV. Signed-in users never
// load it.
import { useEffect, useState } from "preact/hooks";
import { ApiError, api } from "../lib/api.ts";
import { loadMe } from "../lib/state.ts";

/** Sign-in errors that come back in ?login_error= (single sign-on, Google). */
const LOGIN_ERRORS: Record<string, string> = {
  sso_required: "Your organization uses single sign-on. Sign in with SSO.",
  sso_unknown_domain: "Single sign-on is not set up for this email domain.",
  sso_other_team: "This account is not in your organization's team. Ask a team admin to add it.",
  sso_domain: "Your identity provider signed you in with an email outside your organization.",
  sso_unverified_email: "Your identity provider has not verified your email.",
  sso_failed: "Single sign-on failed. Try again.",
  no_seats: "Your organization's team has no free seats.",
  deactivated: "Your organization deactivated this account.",
};

export function CalDavLogin() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // An email that several accounts hold may start one more (accounts-login-emails-permissions.md rule 3.3).
  const [offer, setOffer] = useState<HTMLFormElement | null>(null);
  const send = async (form: HTMLFormElement, newAccount: boolean) => {
    const f = new FormData(form);
    setPending(true);
    setError(null);
    setOffer(null);
    try {
      await api("POST", "/auth/caldav", {
        serverUrl: f.get("serverUrl"),
        username: f.get("username"),
        password: f.get("password"),
        ...(f.get("email") ? { email: f.get("email") } : {}),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(newAccount ? { newAccount } : {}),
      });
      await loadMe();
    } catch (err) {
      const code =
        err instanceof ApiError ? (err.body as { error?: string } | undefined)?.error : undefined;
      if (code === "several_accounts") setOffer(form);
      setError(
        code === "several_accounts"
          ? "This email belongs to more than one Tempoloom account, so Tempoloom cannot choose one. You can create a new Tempoloom account with it."
          : code === "email_taken"
            ? "This email is the main email of another Tempoloom account. Sign in with that account's calendar, then add this one there."
            : code === "invalid_credentials"
              ? "The server rejected the user name or password."
              : code === "deactivated"
                ? "Your organization deactivated this account."
                : code === "sso_required" || code === "no_seats"
                  ? (LOGIN_ERRORS[code] ?? "")
                  : code === "email_required"
                    ? "Enter your email address."
                    : code === "no_calendars"
                      ? "This account has no calendars."
                      : "Could not reach the CalDAV server.",
      );
    } finally {
      setPending(false);
    }
  };
  const submit = (e: Event) => {
    e.preventDefault();
    void send(e.currentTarget as HTMLFormElement, false);
  };
  return (
    <form class="login-form" onSubmit={submit} data-testid="caldav-form">
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
      <label>
        Email (if the user name is not an email)
        <input name="email" type="email" />
      </label>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {offer && (
        <button type="button" disabled={pending} onClick={() => void send(offer, true)}>
          Create a new Tempoloom account
        </button>
      )}
      <button type="submit" class="primary" disabled={pending}>
        {pending ? "Connecting…" : "Sign in with CalDAV"}
      </button>
    </form>
  );
}

export function Login() {
  const err = new URLSearchParams(location.search).get("login_error");
  const [methods, setMethods] = useState<{ google: boolean } | null>(null);
  useEffect(() => {
    void api<{ google: boolean }>("GET", "/auth/methods").then(setMethods);
  }, []);
  return (
    <div class="login">
      <div class="card">
        <h1>Tempoloom</h1>
        <p>Plan tasks, habits and focus time around your meetings.</p>
        {err && (
          <p class="error" role="alert">
            {LOGIN_ERRORS[err] ?? `Sign-in failed: ${err}`}
          </p>
        )}
        {methods?.google && (
          <a class="button primary" href="/auth/google/start">
            Sign in with Google
          </a>
        )}
        <form class="login-form" method="get" action="/auth/sso/start" data-testid="sso-form">
          <label>
            Work email
            <input name="email" type="email" required autocomplete="email" />
          </label>
          <button type="submit">Sign in with SSO</button>
        </form>
        <details open={methods !== null && !methods.google}>
          <summary>Use a CalDAV calendar</summary>
          <CalDavLogin />
        </details>
      </div>
    </div>
  );
}
