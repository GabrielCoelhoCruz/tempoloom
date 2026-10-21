// Planner view controls, loaded after the planner (docs/performance.md): the gear
// menu with the days shown (planning-planner.md PLN-3), "view as" (PLN-6) and
// the connected calendars panel (PLN-20).
import { useEffect, useState } from "preact/hooks";
import type { Settings } from "../../server/settings.ts";
import { api } from "../lib/api.ts";
import { calendarList, displayName, loadCalendars } from "../lib/calendars.tsx";
import { viewAs } from "../lib/planner-signals.ts";
import { onLinkClick } from "../lib/router.ts";
import { me } from "../lib/state.ts";
import "./parts.css";

const DAYS: [Settings["plannerDays"], string][] = [
  ["all-days", "All days"],
  ["weekdays", "Weekdays only"],
  ["rolling-9-days", "Rolling 9 days"],
];

const POP = { top: "36px", right: 0 };

/** Saves planner view settings and shows them at once; the server answer wins. */
async function save(patch: Partial<Settings>): Promise<void> {
  const m = me.value;
  if (!m) return;
  me.value = { ...m, settings: { ...m.settings, ...patch } };
  const r = await api<{ settings: Settings }>("PATCH", "/api/settings", patch);
  if (me.value) me.value = { ...me.value, settings: r.settings };
}

function CalendarsPanel({ hidden }: { hidden: string[] }) {
  useEffect(() => void loadCalendars(), []);
  const all = calendarList.value;
  const connected = all.filter((c) => c.check_availability === 1);
  return (
    <div class="popover" style={POP} data-testid="calendars-panel">
      <h3>Connected calendars</h3>
      {connected.map((c) => (
        <label class="inline" key={c.id}>
          <input
            type="checkbox"
            checked={!hidden.includes(c.id)}
            onChange={(e) => {
              const show = e.currentTarget.checked;
              void save({
                hiddenCalendars: show
                  ? hidden.filter((id) => id !== c.id)
                  : [...hidden.filter((id) => id !== c.id), c.id],
              });
            }}
          />
          {displayName(c, all)}
        </label>
      ))}
      <p class="meta">Hidden calendars stay connected: their events still block time.</p>
      <a class="button" href="/settings" onClick={onLinkClick}>
        Edit calendars
      </a>
    </div>
  );
}

export function PlannerOptions() {
  const [open, setOpen] = useState<"gear" | "calendars" | null>(null);
  const settings = me.value?.settings;
  if (!settings) return null;
  return (
    <span class="inline" style={{ position: "relative" }}>
      <label class="inline">
        View as
        <select
          value={viewAs.value}
          onChange={(e) => (viewAs.value = e.currentTarget.value as "me" | "others")}
        >
          <option value="me">Me</option>
          <option value="others">Others</option>
        </select>
      </label>
      <button
        type="button"
        aria-expanded={open === "calendars"}
        onClick={() => setOpen(open === "calendars" ? null : "calendars")}
      >
        Calendars
      </button>
      <button
        type="button"
        aria-label="Planner options"
        aria-expanded={open === "gear"}
        onClick={() => setOpen(open === "gear" ? null : "gear")}
      >
        ⚙
      </button>
      {open === "calendars" && <CalendarsPanel hidden={settings.hiddenCalendars} />}
      {open === "gear" && (
        <div class="popover" style={POP} data-testid="planner-options">
          <label>
            Days shown
            <select
              value={settings.plannerDays}
              onChange={(e) =>
                void save({ plannerDays: e.currentTarget.value as Settings["plannerDays"] })
              }
            >
              {DAYS.map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </span>
  );
}
