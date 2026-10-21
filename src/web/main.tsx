import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { render } from "preact";
import { useEffect } from "preact/hooks";
import { lazyComponent, settle, settled } from "./lib/lazy.ts";
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
const Integrations = lazyComponent(() =>
  import("./views/integrations.tsx").then((m) => m.Integrations),
);
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

const HelpPage = lazyComponent(() => import("./views/help.tsx").then((m) => m.HelpPage));
const PreviewBanner = lazyComponent(() =>
  import("./views/preview.tsx").then((m) => m.PreviewBanner),
);
const PoliciesPage = lazyComponent(() =>
  import("./views/policies.tsx").then((m) => m.PoliciesPage),
);
const MeetingChecks = lazyComponent(() =>
  import("./views/meeting-checks.tsx").then((m) => m.MeetingChecks),
);
const Automations = lazyComponent(() =>
  import("./views/automations.tsx").then((m) => m.Automations),
);
const Priorities = lazyComponent(() => import("./views/priorities.tsx").then((m) => m.Priorities));
const AutomationForm = lazyComponent(() =>
  import("./views/automation-form.tsx").then((m) => m.AutomationForm),
);
// r3 s3: profile page, New task form (TSK-5, TSK-6) and event start alerts (NTF-1, NTF-2).
const ProfilePage = lazyComponent(() => import("./views/profile.tsx").then((m) => m.ProfilePage));
const NewTaskDialog = lazyComponent<{ onClose: () => void }>(() =>
  import("./views/task-dialog.tsx").then((m) => m.NewTaskDialog),
);
const Alerts = lazyComponent(() => import("./views/alerts.tsx").then((m) => m.Alerts));
const OAuthConsent = lazyComponent(() =>
  import("./views/oauth-consent.tsx").then((m) => m.OAuthConsent),
);
// The sign-in page is for signed-out visitors only; it loads on demand.
const Login = lazyComponent(() => import("./views/login.tsx").then((m) => m.Login));
const CalDavLogin = lazyComponent(() => import("./views/login.tsx").then((m) => m.CalDavLogin));
const newTask = signal(false);
addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement | null;
  if (e.key !== "c" || e.ctrlKey || e.metaKey || e.altKey || !me.value) return;
  if (t?.closest("input, textarea, select, [contenteditable], [role=dialog]")) return;
  e.preventDefault();
  newTask.value = true;
});

const NAV: { href: string; label: string }[] = [
  { href: "/", label: "Planner" },
  { href: "/tasks", label: "Tasks" },
  { href: "/habits", label: "Habits" },
  { href: "/meetings", label: "Meetings" },
  { href: "/meeting-checks", label: "Meeting checks" },
  { href: "/automations", label: "Automations" },
  { href: "/priorities", label: "Priorities" },
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

/** The top-bar create button (automations-overview.md rule 1). */
function CreateMenu() {
  const items = [
    { href: "/habits", label: "Habit" },
    { href: "/automations/new/focus_time", label: "Focus time" },
    { href: "/automations/new/buffer", label: "Buffer" },
    { href: "/meetings", label: "Flexible meeting" },
  ];
  return (
    <details class="create-menu" data-testid="create-menu">
      <summary>Create</summary>
      {items.map((i) => (
        <a
          key={i.href}
          href={i.href}
          onClick={(e) => {
            (e.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute(
              "open",
            );
            onLinkClick(e);
          }}
        >
          {i.label}
        </a>
      ))}
    </details>
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
    case "/settings/integrations":
      return <Integrations />;
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
    case "/meeting-checks":
      return <MeetingChecks />;
    case "/automations":
      return <Automations />;
    case "/priorities":
      return <Priorities />;
    case "/profile":
      return <ProfilePage />;
    default:
      if (path.value.startsWith("/join/")) return <JoinPage token={path.value.slice(6)} />;
      if (path.value === "/help" || path.value.startsWith("/help/")) return <HelpPage />;
      if (path.value.startsWith("/automations/")) return <AutomationForm key={path.value} />;
      return <Planner />;
  }
}

function App() {
  const isPublic = path.value.startsWith("/book/") || path.value.startsWith("/tools/");
  useEffect(() => {
    if (!isPublic) void loadMe();
  }, [isPublic]);
  // The planner settles after its first data; other pages at once, and every
  // page after a second at the latest (lib/lazy.ts).
  useEffect(() => {
    if (me.value && path.value !== "/") settle();
  }, [me.value, path.value]);
  useEffect(() => {
    const t = setTimeout(settle, 1000);
    return () => clearTimeout(t);
  }, []);
  if (path.value === "/tools/meeting-cost") return <MeetingCost />;
  if (path.value === "/tools/pomodoro") return <Pomodoro />;
  if (isPublic) return <PublicBooking path={path.value} />;
  if (me.value === undefined) return null;
  if (me.value === null && path.value.startsWith("/join/"))
    return <JoinPage token={path.value.slice(6)} login={<CalDavLogin />} />;
  if (me.value === null) return <Login />;
  // An AI tool's OAuth sign-in: the consent page, without the app around it.
  if (path.value === "/oauth/authorize") return <OAuthConsent />;
  return (
    <div class="shell" data-testid="app-shell">
      <nav class="nav">
        <div class="brand">Tempoloom</div>
        <CreateMenu />
        <button type="button" class="primary" onClick={() => (newTask.value = true)}>
          New task
        </button>
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
        {settled.value && path.value !== "/" && <PreviewBanner />}
        {!me.value.accounts.some((a) => !a.viaGrant) && <ConnectCalendar />}
        <Page />
      </main>
      {newTask.value && <NewTaskDialog onClose={() => (newTask.value = false)} />}
      {settled.value && <Alerts />}
    </div>
  );
}

const root = document.getElementById("app");
if (root) render(<App />, root);
