import type { ComponentChildren } from "preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ApiError, api } from "./lib/api.ts";
import { lazyComponent } from "./lib/lazy.ts";
import { onLinkClick, path } from "./lib/router.ts";
import { loadMe, me } from "./lib/state.ts";
import { AccountMenu, ActingBanner } from "./views/account-menu.tsx";
import { Planner } from "./views/planner.tsx";

// Only the planner is in the first chunk; every other page loads on first use.
const Tasks = lazyComponent(() => import("./views/tasks.tsx").then((m) => m.Tasks));
const Habits = lazyComponent(() => import("./views/habits.tsx").then((m) => m.Habits));
const Meetings = lazyComponent(() => import("./views/meetings.tsx").then((m) => m.Meetings));
const Library = lazyComponent(() => import("./views/library.tsx").then((m) => m.Library));
const Settings = lazyComponent(() => import("./views/settings.tsx").then((m) => m.Settings));
const StatsPage = lazyComponent(() => import("./views/stats.tsx").then((m) => m.StatsPage));
const MeetingCost = lazyComponent(() => import("./views/tools.tsx").then((m) => m.MeetingCost));
const Pomodoro = lazyComponent(() => import("./views/tools.tsx").then((m) => m.Pomodoro));
const PublicBooking = lazyComponent<{ path: string }>(() =>
  import("./views/book.tsx").then((m) => m.PublicBooking),
);

const TeamPage = lazyComponent(() => import("./views/team.tsx").then((m) => m.TeamPage));
const AccountPage = lazyComponent(() => import("./views/account.tsx").then((m) => m.AccountPage));
const Links = lazyComponent(() => import("./views/links.tsx").then((m) => m.Links));
const JoinPage = lazyComponent<{ token: string; login?: ComponentChildren }>(() =>
  import("./views/team.tsx").then((m) => m.JoinPage),
);
const TeamStats = lazyComponent(() => import("./views/team-stats.tsx").then((m) => m.TeamStats));
const OrgAnalytics = lazyComponent(() =>
  import("./views/org-analytics.tsx").then((m) => m.OrgAnalytics),
);
const ConnectCalendar = lazyComponent(() =>
  import("./views/connect.tsx").then((m) => m.ConnectCalendar),
);

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
const HelpPage = lazyComponent(() => import("./views/help.tsx").then((m) => m.HelpPage));
const PreviewBanner = lazyComponent(() =>
  import("./views/preview.tsx").then((m) => m.PreviewBanner),
);
const PoliciesPage = lazyComponent(() =>
  import("./views/policies.tsx").then((m) => m.PoliciesPage),
);

const NAV: { href: string; label: string }[] = [
  { href: "/", label: "Planner" },
  { href: "/tasks", label: "Tasks" },
  { href: "/habits", label: "Habits" },
  { href: "/meetings", label: "Meetings" },
  { href: "/library", label: "Library" },
  { href: "/links", label: "Booking links" },
  { href: "/stats", label: "Stats" },
  { href: "/team", label: "Team" },
  { href: "/policies", label: "Policies" },
  { href: "/settings", label: "Settings" },
  { href: "/account", label: "Account" },
  { href: "/help", label: "Help" },
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

function Page() {
  switch (path.value) {
    case "/tasks":
      return <Tasks />;
    case "/habits":
      return <Habits />;
    case "/meetings":
      return <Meetings />;
    case "/library":
      return <Library />;
    case "/settings":
      return <Settings />;
    case "/links":
      return <Links />;
    case "/stats":
      return <StatsPage />;
    case "/stats/team":
      return <TeamStats />;
    case "/stats/organization":
      return <OrgAnalytics />;
    case "/team":
      return <TeamPage />;
    case "/policies":
      return <PoliciesPage />;
    case "/account":
      return <AccountPage />;
    default:
      if (path.value.startsWith("/join/")) return <JoinPage token={path.value.slice(6)} />;
      if (path.value === "/help" || path.value.startsWith("/help/")) return <HelpPage />;
      return <Planner />;
  }
}

function App() {
  const isPublic = path.value.startsWith("/book/") || path.value.startsWith("/tools/");
  useEffect(() => {
    if (!isPublic) void loadMe();
  }, [isPublic]);
  if (path.value === "/tools/meeting-cost") return <MeetingCost />;
  if (path.value === "/tools/pomodoro") return <Pomodoro />;
  if (isPublic) return <PublicBooking path={path.value} />;
  if (me.value === undefined) return null;
  if (me.value === null && path.value.startsWith("/join/"))
    return <JoinPage token={path.value.slice(6)} login={<CalDavLogin />} />;
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
        <AccountMenu />
        <form method="post" action="/auth/logout">
          <button type="submit">Sign out</button>
        </form>
      </nav>
      <main class="main">
        <ActingBanner />
        {path.value !== "/" && <PreviewBanner />}
        {!me.value.accounts.some((a) => !a.viaGrant) && <ConnectCalendar />}
        <Page />
      </main>
    </div>
  );
}

const root = document.getElementById("app");
if (root) render(<App />, root);
