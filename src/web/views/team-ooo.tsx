// Team page: out-of-office calendars (docs/specs/teams-ooo-calendar.md).
import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import { errorText } from "./team.tsx";
import "./pages.css";

interface Settings {
  allowMembers: boolean;
  includeAllDayBusy: boolean;
  partialDayDisplay: "exact_times" | "all_day";
}

interface Info {
  isAdmin: boolean;
  canCreate: boolean;
  settings: Settings;
  calendars: {
    id: string;
    name: string;
    owner: { name: string; email: string };
    calendar: string | null;
    participants: { name: string; email: string }[];
    problem: string | null;
    canDelete: boolean;
  }[];
}

function AddForm({ onDone }: { onDone: (error?: string) => void }) {
  const [calendars, setCalendars] = useState<{ id: string; name: string }[] | null>(null);
  useEffect(() => {
    void (async () => {
      // A shared calendar made a moment ago must show: read the calendar list again.
      await api("POST", "/api/calendars/refresh");
      const r = await api<{ calendars: { id: string; name: string; writable: number }[] }>(
        "GET",
        "/api/calendars",
      );
      setCalendars(r.calendars.filter((c) => c.writable));
    })();
  }, []);
  return (
    <form
      class="form"
      data-testid="ooo-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget as HTMLFormElement);
        try {
          await api("POST", "/api/team/ooo", {
            name: String(f.get("name") ?? ""),
            calendarId: String(f.get("calendarId") ?? ""),
          });
          onDone();
        } catch (err) {
          onDone(errorText(err));
        }
      }}
    >
      <label>
        Name
        <input name="name" required maxLength={100} placeholder="Team OOO" />
      </label>
      <label>
        Shared calendar
        <select name="calendarId" required>
          {(calendars ?? []).map((c) => (
            <option value={c.id} key={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <p class="meta wide">
        Share this calendar with your teammates with permission to change events. You become its
        owner: Tempoloom writes the copies with your account.
      </p>
      <button type="submit" class="primary" disabled={!calendars}>
        Create
      </button>
    </form>
  );
}

function SettingsForm({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
  const [saved, setSaved] = useState(false);
  return (
    <form
      class="form"
      data-testid="ooo-settings"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget as HTMLFormElement);
        setSaved(false);
        await api("PATCH", "/api/team/ooo/settings", {
          allowMembers: f.get("allowMembers") === "on",
          includeAllDayBusy: f.get("includeAllDayBusy") === "on",
          partialDayDisplay: String(f.get("partialDayDisplay")),
        });
        setSaved(true);
        onSaved();
      }}
    >
      <label class="inline wide">
        <input type="checkbox" name="allowMembers" defaultChecked={settings.allowMembers} />
        Members can add out-of-office calendars
      </label>
      <label class="inline wide">
        <input
          type="checkbox"
          name="includeAllDayBusy"
          defaultChecked={settings.includeAllDayBusy}
        />
        Count all-day busy events as time away
      </label>
      <label>
        Partial-day time away
        <select name="partialDayDisplay">
          <option value="exact_times" selected={settings.partialDayDisplay === "exact_times"}>
            Exact times
          </option>
          <option value="all_day" selected={settings.partialDayDisplay === "all_day"}>
            As all-day events
          </option>
        </select>
      </label>
      <p class="meta wide">Changes apply to time away added from now on; existing copies stay.</p>
      <button type="submit" class="primary">
        Save out-of-office settings
      </button>
      {saved && (
        <span class="status" data-testid="ooo-saved">
          Saved.
        </span>
      )}
    </form>
  );
}

export function OutOfOffice() {
  const [info, setInfo] = useState<Info | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => setInfo(await api<Info>("GET", "/api/team/ooo")), []);
  useEffect(() => void load(), [load]);
  if (!info) return null;
  return (
    <section data-testid="ooo">
      <div class="toolbar-inline">
        <h2>Out-of-office calendars</h2>
        {info.canCreate && (
          <button type="button" onClick={() => setAdding(!adding)}>
            Add a calendar
          </button>
        )}
      </div>
      <p class="meta">
        People add time off to their own calendar as usual. Tempoloom copies it to the shared
        calendar for each team member who can change events in that calendar.
      </p>
      {adding && (
        <AddForm
          onDone={(err) => {
            setError(err ?? null);
            if (!err) setAdding(false);
            void load();
          }}
        />
      )}
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <div class="list">
        {info.calendars.map((o) => (
          <div class="row" key={o.id} data-ooo={o.name}>
            <div>
              <div>{o.name}</div>
              <div class="meta">
                Owner: {o.owner.name} ({o.owner.email}) · Calendar: {o.calendar ?? "missing"}
              </div>
              <div class="meta" data-testid="participants">
                Participants ({o.participants.length}):{" "}
                {o.participants.map((p) => `${p.name} (${p.email})`).join(", ") || "none"}
              </div>
              {o.problem && <div class="error">{o.problem}</div>}
            </div>
            {o.canDelete && (
              <div class="actions">
                <button
                  type="button"
                  class="danger"
                  onClick={async () => {
                    await api("DELETE", `/api/team/ooo/${o.id}`);
                    await load();
                  }}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        ))}
        {info.calendars.length === 0 && <p class="status">No out-of-office calendars yet.</p>}
      </div>
      {info.isAdmin && <SettingsForm settings={info.settings} onSaved={() => void load()} />}
    </section>
  );
}
