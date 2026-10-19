import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import {
  freeName,
  GROUP_NAMES,
  LIBRARY,
  type LibraryEntry,
  type LibraryGroup,
} from "../lib/library.ts";
import { navigate } from "../lib/router.ts";
import { planNow } from "../lib/state.ts";

const FORM_PAGE: Partial<Record<LibraryEntry["kind"], string>> = {
  habit: "/habits",
  flexible_meeting: "/meetings",
  booking_link: "/links",
  calendar_mirroring: "/settings",
  meeting_overload: "/settings",
};

/** Names of the user's automations; an entry with the same name shows "Added" (rule 4). */
async function automationNames(): Promise<string[]> {
  const [h, b, f, m, l, o] = await Promise.all([
    api<{ habits: { title: string }[] }>("GET", "/api/habits"),
    api<{ buffers: { title: string }[] }>("GET", "/api/buffers"),
    api<{ focus: { title: string }[] }>("GET", "/api/focus"),
    api<{ meetings: { title: string }[] }>("GET", "/api/meetings"),
    api<{ links: { title: string }[] }>("GET", "/api/booking/links").catch(() => ({ links: [] })),
    api<{ overloads: { title: string }[] }>("GET", "/api/meeting-overloads"),
  ]);
  return [...h.habits, ...b.buffers, ...f.focus, ...m.meetings, ...l.links, ...o.overloads].map(
    (x) => x.title,
  );
}

export function Library() {
  const [tab, setTab] = useState<LibraryGroup | "all">("all");
  const [names, setNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => setNames(await automationNames()), []);
  useEffect(() => void load(), [load]);

  const added = (e: LibraryEntry) => names.some((n) => n.toLowerCase() === e.name.toLowerCase());

  /** Buffers and focus time have no form of their own yet: the entry adds them as they are. */
  const addNow = async (e: LibraryEntry) => {
    setError(null);
    const title = freeName(e.name, names);
    try {
      if (e.kind === "buffer") await api("POST", "/api/buffers", { title, ...e.preset });
      else if (e.kind === "focus_time") await api("POST", "/api/focus", { title, ...e.preset });
      await planNow();
      await load();
    } catch (err) {
      const body = (err as { body?: { issues?: { message: string }[] } }).body;
      setError(body?.issues?.[0]?.message ?? String(err));
    }
  };

  const shown = LIBRARY.filter((e) => tab === "all" || e.group === tab);
  return (
    <div class="page" data-testid="library-page">
      <h1>Library</h1>
      <p>Ready-made starting points. Pick one, check its settings, and save.</p>
      <div class="actions" role="tablist">
        {(["all", ...Object.keys(GROUP_NAMES)] as (LibraryGroup | "all")[]).map((g) => (
          <button
            type="button"
            role="tab"
            key={g}
            aria-selected={tab === g}
            onClick={() => setTab(g)}
          >
            {g === "all" ? "All" : GROUP_NAMES[g]}
          </button>
        ))}
      </div>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <div class="list" data-testid="library-list">
        {shown.map((e) => {
          const page = e.kind === "buffer" && e.form ? "/settings" : FORM_PAGE[e.kind];
          return (
            <div class="row" key={e.slug} data-testid="library-entry" data-entry={e.name}>
              <div>
                <div>
                  {e.name} {added(e) && <span class="badge">Added</span>}
                </div>
                <div class="meta">{e.summary}</div>
                {e.kind === "unavailable" && <div class="meta warning">{e.reason}</div>}
              </div>
              <div class="actions">
                {page && (
                  <button type="button" onClick={() => navigate(`${page}?template=${e.slug}`)}>
                    Use
                  </button>
                )}
                {((e.kind === "buffer" && !e.form) || e.kind === "focus_time") && (
                  <button type="button" onClick={() => void addNow(e)}>
                    Add
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
