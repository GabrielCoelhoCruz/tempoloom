import { useCallback, useEffect, useState } from "preact/hooks";
import { itemHoursOf } from "../../shared/item-hours.ts";
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
  buffer: "/automations/new/buffer",
  focus_time: "/automations/new/focus_time",
  flexible_meeting: "/meetings",
  booking_link: "/links",
  calendar_mirroring: "/settings",
  meeting_overload: "/settings",
  meeting_check: "/meeting-checks",
  no_meeting_day: "/settings",
};

/** Kinds whose automations remember the entry they came from (rule 4). */
const BY_TEMPLATE = new Set<LibraryEntry["kind"]>([
  "habit",
  "buffer",
  "focus_time",
  "calendar_mirroring",
]);

/**
 * Names of the user's automations, booking links and meeting overloads, and
 * the entries their automations came from. A habit, buffer, focus or mirroring
 * entry shows "Added" when an automation came from it; other kinds when one has
 * the entry's name (rule 4).
 */
async function automationNames(): Promise<{ names: string[]; templates: string[] }> {
  const [a, l, o, m] = await Promise.all([
    api<{ automations: { name: string; templateId: string | null }[] }>("GET", "/api/automations"),
    api<{ links: { title: string }[] }>("GET", "/api/booking/links").catch(() => ({ links: [] })),
    api<{ overloads: { title: string }[] }>("GET", "/api/meeting-overloads"),
    api<{ mirrors: { template_id: string | null }[] }>("GET", "/api/mirrors"),
  ]);
  return {
    names: [
      ...a.automations.map((x) => x.name),
      ...l.links.map((x) => x.title),
      ...o.overloads.map((x) => x.title),
    ],
    templates: [...a.automations, ...m.mirrors.map((x) => ({ templateId: x.template_id }))].flatMap(
      (x) => (x.templateId ? [x.templateId] : []),
    ),
  };
}

/** Meeting check entries and the no-meeting day are added when their settings are on. */
async function meetingEntries(): Promise<string[]> {
  const [checks, day] = await Promise.all([
    api<{ prefs: { libraryEntries: string[]; checks: Record<string, boolean> } }>(
      "GET",
      "/api/meeting-checks",
    ),
    api<{ weekday: number | null }>("GET", "/api/no-meeting-day"),
  ]);
  const on = LIBRARY.filter(
    (e) =>
      e.kind === "meeting_check" &&
      checks.prefs.libraryEntries.includes(e.slug) &&
      e.preset.checks.every((c) => checks.prefs.checks[c]),
  ).map((e) => e.slug);
  return day.weekday === null ? on : [...on, "no-meeting-day"];
}

export function Library() {
  const [tab, setTab] = useState<LibraryGroup | "all">("all");
  const [known, setKnown] = useState<{ names: string[]; templates: string[] }>({
    names: [],
    templates: [],
  });
  const [slugs, setSlugs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [k, s] = await Promise.all([automationNames(), meetingEntries()]);
    setKnown(k);
    setSlugs(s);
  }, []);
  useEffect(() => void load(), [load]);

  const added = (e: LibraryEntry) =>
    e.kind === "meeting_check" || e.kind === "no_meeting_day"
      ? slugs.includes(e.slug)
      : BY_TEMPLATE.has(e.kind)
        ? known.templates.includes(e.slug)
        : known.names.some((n) => n.toLowerCase() === e.name.toLowerCase());

  /** "Add" saves a buffer or focus entry as it is; "Use" opens its form first. */
  const addNow = async (e: LibraryEntry) => {
    setError(null);
    const title = freeName(e.name, known.names);
    const base = { title, templateId: e.slug };
    try {
      if (e.kind === "buffer") await api("POST", "/api/buffers", { ...base, ...e.preset });
      else if (e.kind === "focus_time") {
        const { window, ...rules } = e.preset;
        await api("POST", "/api/focus", {
          ...base,
          ...rules,
          ...(window ? { itemHours: itemHoursOf(window) } : {}),
        });
      }
      await planNow();
      await load();
    } catch (err) {
      const issues = (err as { body?: { issues?: { message: string }[] } }).body;
      setError(issues?.issues?.[0]?.message ?? String(err));
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
