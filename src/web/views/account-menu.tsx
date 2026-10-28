// The account menu and the acting banner of delegated access
// (docs/specs/accounts-delegated-access.md rules 5, 6, 8, 10). Both show on
// every page, so they stay small and load with the shell.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import { startLive } from "../lib/live.ts";
import { byKeyboard } from "../lib/motion.ts";
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

const ENDED = "Your access to that account ended. You are back in your own account.";

export function ActingBanner() {
  const m = me.value;
  if (m?.actor) {
    const text = `You are acting in ${m.user.name}'s account (${m.user.email}). Changes go to their calendar.`;
    return (
      <div class="note warning" role="status" data-testid="acting-banner">
        <span class="note-text" title={text}>
          {text}
        </span>
        <span class="note-actions">
          <button type="button" class="sm" onClick={() => void actAs(null)}>
            Exit
          </button>
        </span>
      </div>
    );
  }
  if (accessEnded)
    return (
      <div class="note" role="status" data-testid="acting-ended">
        <span class="note-text" title={ENDED}>
          {ENDED}
        </span>
      </div>
    );
  return null;
}

/**
 * The account menu (ui-refresh.md CMP-42): Enter, Space or ArrowDown open it on
 * the first item, ArrowUp on the last; arrows wrap, Home and End jump, a letter
 * moves to the next item that starts with it; Escape returns to the trigger.
 */
export function AccountMenu() {
  // How the menu opened: by a pointer (no item has the focus), or on its first or last item.
  const [open, setOpen] = useState<false | "pointer" | "first" | "last">(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // Connect after the first render, so the planner's cold load does not wait for it.
  useEffect(() => startLive(me.value?.live, () => void loadMe()), []);
  // Listen at once, not after paint: an Escape right after opening must close the menu.
  useLayoutEffect(() => {
    if (!open) return;
    const items = [...(menu.current?.children ?? [])] as HTMLElement[];
    if (open !== "pointer") items.at(open === "first" ? 0 : -1)?.focus();
    const close = (e: Event) => {
      if (
        e instanceof KeyboardEvent
          ? e.key !== "Escape"
          : (e.target as Element).closest(".account-menu")
      )
        return;
      setOpen(false);
      if (e instanceof KeyboardEvent) trigger.current?.focus();
    };
    addEventListener("keydown", close);
    addEventListener("pointerdown", close);
    return () => {
      removeEventListener("keydown", close);
      removeEventListener("pointerdown", close);
    };
  }, [open]);
  const m = me.value;
  if (!m) return null;
  const self = m.actor ?? m.user;
  const onMenuKey = (e: KeyboardEvent) => {
    const items = [...(menu.current?.children ?? [])] as HTMLElement[];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const k = e.key;
    let next: number | undefined;
    if (k === "ArrowDown") next = at + 1;
    else if (k === "ArrowUp") next = Math.max(at, 0) - 1;
    else if (k === "Home") next = 0;
    else if (k === "End") next = -1;
    else if (k === "Tab") setOpen(false);
    else if (k === " ") (document.activeElement as HTMLElement).click();
    else if (k.length === 1)
      for (let j = 1; j <= items.length; j++) {
        const i = (at + j) % items.length;
        if (items[i]?.textContent?.toLowerCase().startsWith(k.toLowerCase())) next = i;
        if (next !== undefined) break;
      }
    if (next === undefined && k !== " ") return;
    e.preventDefault();
    if (next !== undefined) items.at(next % items.length)?.focus();
  };
  return (
    <div class="account-menu">
      <button
        ref={trigger}
        type="button"
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={!!open}
        onClick={(e) => setOpen(open ? false : byKeyboard(e) ? "first" : "pointer")}
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          setOpen(e.key === "ArrowDown" ? "first" : "last");
        }}
      >
        {self.name} ▾
      </button>
      {open && (
        // MOT-6: a menu opened from the keyboard shows at once.
        <div
          class="menu"
          role="menu"
          ref={menu}
          data-instant={open !== "pointer" || undefined}
          onKeyDown={onMenuKey}
        >
          {m.owners
            .filter((o) => o.id !== m.user.id)
            .map((o) => (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                key={o.id}
                onClick={() => void actAs(o.id)}
              >
                Switch to {o.name}'s account
              </button>
            ))}
          {m.actor && (
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => void actAs(null)}>
              Exit {m.user.name}'s account
            </button>
          )}
          <a
            role="menuitem"
            tabIndex={-1}
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
            tabIndex={-1}
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
