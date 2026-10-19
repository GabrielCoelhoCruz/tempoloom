import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import { GROUP_NAMES, LIBRARY, type LibraryEntry, type LibraryGroup } from "../lib/library.ts";
import { navigate } from "../lib/router.ts";

const FORM_PAGE: Partial<Record<LibraryEntry["kind"], string>> = {
  habit: "/habits",
  buffer: "/automations/new/buffer",
  focus_time: "/automations/new/focus_time",
  flexible_meeting: "/meetings",
  booking_link: "/links",
  calendar_mirroring: "/settings",
};

/** Kinds whose automations remember the entry they came from (rule 4). */
const BY_TEMPLATE = new Set<LibraryEntry["kind"]>(["habit", "buffer", "focus_time"]);

/**
 * Names of the user's automations and booking links, and the entries their
 * automations came from. A habit, buffer or focus entry shows "Added" when an
 * automation came from it; other kinds when one has the entry's name (rule 4).
 */
async function automationNames(): Promise<{ names: string[]; templates: string[] }> {
  const [a, l] = await Promise.all([
    api<{ automations: { name: string; templateId: string | null }[] }>("GET", "/api/automations"),
    api<{ links: { title: string }[] }>("GET", "/api/booking/links").catch(() => ({ links: [] })),
  ]);
  return {
    names: [...a.automations.map((x) => x.name), ...l.links.map((x) => x.title)],
    templates: a.automations.flatMap((x) => (x.templateId ? [x.templateId] : [])),
  };
}

export function Library() {
  const [tab, setTab] = useState<LibraryGroup | "all">("all");
  const [known, setKnown] = useState<{ names: string[]; templates: string[] }>({
    names: [],
    templates: [],
  });

  const load = useCallback(async () => setKnown(await automationNames()), []);
  useEffect(() => void load(), [load]);

  const added = (e: LibraryEntry) =>
    BY_TEMPLATE.has(e.kind)
      ? known.templates.includes(e.slug)
      : known.names.some((n) => n.toLowerCase() === e.name.toLowerCase());

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
      <div class="list" data-testid="library-list">
        {shown.map((e) => {
          const page = FORM_PAGE[e.kind];
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
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
