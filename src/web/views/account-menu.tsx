// The account menu and the acting banner of delegated access
// (docs/specs/accounts-delegated-access.md rules 5, 6, 8, 10). Both show on
// every page, so they stay small and load with the shell.
import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import { startLive } from "../lib/live.ts";
import { onLinkClick } from "../lib/router.ts";
import { loadMe, me } from "../lib/state.ts";

// Set by the reload after the owner removed this person's access (rule 10).
const accessEnded = new URLSearchParams(location.search).has("acting_ended");
if (accessEnded) history.replaceState(null, "", location.pathname);

/** Switches into an owner's account, or back with null; the web app reloads in it. */
async function actAs(ownerId: string | null): Promise<void> {
  if (ownerId) await api("POST", "/api/acting", { ownerId });
  else await api("DELETE", "/api/acting");
  location.assign("/");
}

export function ActingBanner() {
  const m = me.value;
  if (m?.actor)
    return (
      <div class="acting-banner" role="status" data-testid="acting-banner">
        <span>
          You are acting in {m.user.name}'s account ({m.user.email}). Changes go to their calendar.
        </span>
        <button type="button" onClick={() => void actAs(null)}>
          Exit
        </button>
      </div>
    );
  if (accessEnded)
    return (
      <div class="acting-banner ended" role="status" data-testid="acting-ended">
        Your access to that account ended. You are back in your own account.
      </div>
    );
  return null;
}

export function AccountMenu() {
  const [open, setOpen] = useState(false);
  // Connect after the first render, so the planner's cold load does not wait for it.
  useEffect(() => startLive(() => void loadMe()), []);
  // Listen at once, not after paint: an Escape right after opening must close the menu.
  useLayoutEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (
        e instanceof KeyboardEvent
          ? e.key === "Escape"
          : !(e.target as Element).closest(".account-menu")
      )
        setOpen(false);
    };
    addEventListener("keydown", close);
    addEventListener("click", close);
    return () => {
      removeEventListener("keydown", close);
      removeEventListener("click", close);
    };
  }, [open]);
  const m = me.value;
  if (!m) return null;
  const self = m.actor ?? m.user;
  return (
    <div class="account-menu">
      <button
        type="button"
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {self.name} ▾
      </button>
      {open && (
        <div class="menu" role="menu">
          {m.owners
            .filter((o) => o.id !== m.user.id)
            .map((o) => (
              <button type="button" role="menuitem" key={o.id} onClick={() => void actAs(o.id)}>
                Switch to {o.name}'s account
              </button>
            ))}
          {m.actor && (
            <button type="button" role="menuitem" onClick={() => void actAs(null)}>
              Exit {m.user.name}'s account
            </button>
          )}
          <a
            role="menuitem"
            href="/profile"
            onClick={(e) => {
              setOpen(false);
              onLinkClick(e);
            }}
          >
            Profile
          </a>
          <a
            role="menuitem"
            href="/account"
            onClick={(e) => {
              setOpen(false);
              onLinkClick(e);
            }}
          >
            Account settings
          </a>
        </div>
      )}
    </div>
  );
}
