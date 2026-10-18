import type { ComponentChildren } from "preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ApiError, api } from "./lib/api.ts";
import { onLinkClick, path } from "./lib/router.ts";
import { loadMe, me } from "./lib/state.ts";
import { PublicBooking } from "./views/book.tsx";
import { Habits } from "./views/habits.tsx";
import { Links } from "./views/links.tsx";
import { Planner } from "./views/planner.tsx";
import { Settings } from "./views/settings.tsx";
import { Tasks } from "./views/tasks.tsx";

const NAV: { href: string; label: string }[] = [
  { href: "/", label: "Planner" },
  { href: "/tasks", label: "Tasks" },
  { href: "/habits", label: "Habits" },
  { href: "/links", label: "Booking links" },
  { href: "/settings", label: "Settings" },
];

function Link({ href, children }: { href: string; children: ComponentChildren }) {
  return (
    <a href={href} onClick={onLinkClick} aria-current={path.value === href ? "page" : undefined}>
      {children}
    </a>
  );
}

function CalDavLogin() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget as HTMLFormElement);
    setPending(true);
    setError(null);
    try {
      await api("POST", "/auth/caldav", {
        serverUrl: f.get("serverUrl"),
        username: f.get("username"),
        password: f.get("password"),
        ...(f.get("email") ? { email: f.get("email") } : {}),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      await loadMe();
    } catch (err) {
      const code =
        err instanceof ApiError ? (err.body as { error?: string } | undefined)?.error : undefined;
      setError(
        code === "invalid_credentials"
          ? "The server rejected the user name or password."
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
      <button type="submit" class="primary" disabled={pending}>
        {pending ? "Connecting…" : "Sign in with CalDAV"}
      </button>
    </form>
  );
}

function Login() {
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
        {err && <p class="error">Sign-in failed: {err}</p>}
        {methods?.google && (
          <a class="button primary" href="/auth/google/start">
            Sign in with Google
          </a>
        )}
        <details open={methods !== null && !methods.google}>
          <summary>Use a CalDAV calendar</summary>
          <CalDavLogin />
        </details>
      </div>
    </div>
  );
}

function Page() {
  switch (path.value) {
    case "/tasks":
      return <Tasks />;
    case "/habits":
      return <Habits />;
    case "/settings":
      return <Settings />;
    case "/links":
      return <Links />;
    default:
      return <Planner />;
  }
}

function App() {
  const isPublic = path.value.startsWith("/book/");
  useEffect(() => {
    if (!isPublic) void loadMe();
  }, [isPublic]);
  if (isPublic) return <PublicBooking path={path.value} />;
  if (me.value === undefined) return null;
  if (me.value === null) return <Login />;
  return (
    <div class="shell" data-testid="app-shell">
      <nav class="nav">
        <div class="brand">Tempoloom</div>
        {NAV.map((n) => (
          <Link href={n.href} key={n.href}>
            {n.label}
          </Link>
        ))}
        <div class="spacer" />
        <div class="status" data-testid="user-email">
          {me.value.user.email}
        </div>
        <form method="post" action="/auth/logout">
          <button type="submit">Sign out</button>
        </form>
      </nav>
      <main class="main">
        <Page />
      </main>
    </div>
  );
}

const root = document.getElementById("app");
if (root) render(<App />, root);
