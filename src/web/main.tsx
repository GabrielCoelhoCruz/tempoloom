import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { render } from "preact";
import { useEffect } from "preact/hooks";
import { ApiError, api } from "./lib/api.ts";
import { onLinkClick, path } from "./lib/router.ts";

interface Me {
  user: { id: string; email: string; name: string; time_zone: string };
}

const me = signal<Me | null | undefined>(undefined);

async function loadMe(): Promise<void> {
  try {
    me.value = await api<Me>("GET", "/api/me");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) me.value = null;
    else throw err;
  }
}

const NAV: { href: string; label: string }[] = [
  { href: "/", label: "Planner" },
  { href: "/tasks", label: "Tasks" },
  { href: "/habits", label: "Habits" },
  { href: "/settings", label: "Settings" },
];

function Link({ href, children }: { href: string; children: ComponentChildren }) {
  return (
    <a href={href} onClick={onLinkClick} aria-current={path.value === href ? "page" : undefined}>
      {children}
    </a>
  );
}

function Login() {
  const err = new URLSearchParams(location.search).get("login_error");
  return (
    <div class="login">
      <div class="card">
        <h1>Tempoloom</h1>
        <p>Plan tasks, habits and focus time around your meetings.</p>
        {err && <p class="error">Sign-in failed: {err}</p>}
        <a class="button primary" href="/auth/google/start">
          Sign in with Google
        </a>
      </div>
    </div>
  );
}

function Shell({ children }: { children: ComponentChildren }) {
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
        <div class="status">{me.value?.user.email}</div>
        <form method="post" action="/auth/logout">
          <button type="submit">Sign out</button>
        </form>
      </nav>
      <main class="main">{children}</main>
    </div>
  );
}

function App() {
  useEffect(() => {
    void loadMe();
  }, []);
  if (me.value === undefined) return null;
  if (me.value === null) return <Login />;
  return <Shell>{path.value}</Shell>;
}

const root = document.getElementById("app");
if (root) render(<App />, root);
