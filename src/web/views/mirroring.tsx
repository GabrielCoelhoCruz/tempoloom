// Calendar mirroring on the Settings page (docs/specs/sync-calendar-mirroring.md
// rules 1-13, 26, 29, 39, 40, edge cases 11, 16): the policy form, the list
// with one tab per account, edit, the status toggle and delete.
import { useCallback, useEffect, useId, useState } from "preact/hooks";
import type { Settings as UserSettings } from "../../server/settings.ts";
import { api } from "../lib/api.ts";
import {
  type Ask,
  type CalendarRow,
  Confirm,
  calendarList,
  displayName,
  failure,
  loadCalendars,
} from "../lib/calendars.tsx";
import { COLORS } from "../lib/categories.ts";
import { toLocalInput } from "../lib/format.ts";
import { templateFromUrl } from "../lib/library.ts";
import { me, planNow, zone } from "../lib/state.ts";

type NoReply = UserSettings["noReplyCopies"];

interface Policy {
  id: string;
  source_calendar_id: string;
  dest_calendar_id: string;
  source_name: string;
  dest_name: string;
  source_account_id: string;
  dest_account_id: string;
  calendar_type: string;
  visibility: string;
  all_day_mode: string;
  copy_outside_work_hours: number;
  color_override: string | null;
  enabled: number;
  /** Emails of the policy's accounts that are disconnected, or null. */
  disconnected: string | null;
}

interface Fields {
  source: string;
  dest: string;
  visibility: string;
  calendarType: string;
  allDayMode: string;
  color: string;
  outside: boolean;
}

const WARNING =
  "People who can change the destination calendar, and domain admins, can still see the details of these copies.";

function PolicyForm({
  testid,
  initial,
  calendars,
  submit,
  onSave,
  onCancel,
}: {
  testid: string;
  initial: Fields;
  calendars: CalendarRow[];
  submit: string;
  onSave: (f: Fields) => void;
  onCancel?: () => void;
}) {
  const [f, setF] = useState(initial);
  // Labels point at their control: a wrapping label would also hold every option's text.
  const id = useId();
  const options = calendars.filter((c) => c.provider !== "ics");
  const set = (k: keyof Fields) => (e: Event) => {
    const value = (e.currentTarget as HTMLSelectElement).value;
    setF((prev) => ({ ...prev, [k]: value }));
  };
  return (
    <form
      class="form"
      data-testid={testid}
      onSubmit={(e) => {
        e.preventDefault();
        // The form holds the newest choices, also before a render caught up.
        const d = new FormData(e.currentTarget as HTMLFormElement);
        onSave({
          source: String(d.get("source")),
          dest: String(d.get("dest")),
          visibility: String(d.get("visibility")),
          calendarType: String(d.get("calendarType")),
          allDayMode: String(d.get("allDayMode")),
          color: String(d.get("color")),
          outside: d.get("outside") === "on",
        });
      }}
    >
      <div class="field">
        <label for={`${id}-source`}>Copy events from</label>
        <select
          id={`${id}-source`}
          name="source"
          value={f.source || options[0]?.id}
          onChange={set("source")}
        >
          {options.map((c) => (
            <option value={c.id} key={c.id}>
              {displayName(c, calendars)}
            </option>
          ))}
        </select>
      </div>
      <div class="field">
        <label for={`${id}-dest`}>To</label>
        <select
          id={`${id}-dest`}
          name="dest"
          value={f.dest || options[1]?.id}
          onChange={set("dest")}
        >
          {options.map((c) => (
            <option value={c.id} key={c.id}>
              {displayName(c, calendars)}
            </option>
          ))}
        </select>
      </div>
      <div class="field">
        <label for={`${id}-visibility`}>Copies show</label>
        <select
          id={`${id}-visibility`}
          name="visibility"
          value={f.visibility}
          onChange={set("visibility")}
        >
          <option value="label_only">A label only</option>
          <option value="busy_only">"Busy"</option>
          <option value="details_private">Details, private</option>
          <option value="details_default">Details</option>
        </select>
      </div>
      <div class="field">
        <label for={`${id}-calendarType`}>Label</label>
        <select
          id={`${id}-calendarType`}
          name="calendarType"
          value={f.calendarType}
          onChange={set("calendarType")}
        >
          <option value="personal">Personal commitment</option>
          <option value="business">Work commitment</option>
          <option value="travel">Travel</option>
        </select>
      </div>
      <div class="field">
        <label for={`${id}-allDayMode`}>All-day events</label>
        <select
          id={`${id}-allDayMode`}
          name="allDayMode"
          value={f.allDayMode}
          onChange={set("allDayMode")}
        >
          <option value="none">Do not copy</option>
          <option value="busy_only">Copy busy ones</option>
          <option value="all">Copy all</option>
        </select>
      </div>
      <div class="field">
        <label for={`${id}-color`}>Color</label>
        <select id={`${id}-color`} name="color" value={f.color} onChange={set("color")}>
          <option value="">Category colors</option>
          {COLORS.map((c) => (
            <option value={c.id} key={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <label class="inline">
        <input
          type="checkbox"
          name="outside"
          checked={f.outside}
          onChange={(e) => {
            const outside = e.currentTarget.checked;
            setF((prev) => ({ ...prev, outside }));
          }}
        />
        Copy events outside work hours
      </label>
      {f.visibility.startsWith("details") && (
        <p class="meta wide" data-testid="mirror-warning">
          {WARNING}
        </p>
      )}
      <div class="actions wide">
        <button type="submit" class="primary">
          {submit}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

const body = (f: Fields) => ({
  sourceCalendarId: f.source,
  destCalendarId: f.dest,
  visibility: f.visibility,
  calendarType: f.calendarType,
  allDayMode: f.allDayMode,
  copyOutsideWorkHours: f.outside,
  colorOverride: f.color || null,
});

export function MirrorSettings() {
  // A library mirroring entry fills the form (automations-library.md rule 5).
  const fromLibrary = templateFromUrl()?.kind === "calendar_mirroring";
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [reconciledAt, setReconciledAt] = useState<number | null>(null);
  const [tab, setTab] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [created, setCreated] = useState(0);
  const [noReply, setNoReply] = useState<NoReply | null>(null);
  const calendars = calendarList.value;
  const accounts = (me.value?.accounts ?? []).filter((a) => !a.viaGrant);

  const load = useCallback(async () => {
    const r = await api<{ mirrors: Policy[]; reconciledAt: number | null }>("GET", "/api/mirrors");
    setPolicies(r.mirrors);
    setReconciledAt(r.reconciledAt);
  }, []);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    void api<{ settings: Pick<UserSettings, "noReplyCopies"> }>("GET", "/api/settings").then((r) =>
      // A choice made before this first load stays.
      setNoReply((prev) => prev ?? r.settings.noReplyCopies),
    );
  }, []);

  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    setMessage(null);
    try {
      await fn();
      after?.();
      await Promise.all([load(), loadCalendars()]);
      await planNow();
    } catch (err) {
      setMessage(failure(err));
    }
  };

  const byId = new Map(calendars.map((c) => [c.id, c]));
  const nameOf = (id: string, fallback: string) => {
    const c = byId.get(id);
    return c ? displayName(c, calendars) : fallback;
  };
  const shown = tab
    ? policies.filter((p) => p.source_account_id === tab || p.dest_account_id === tab)
    : policies;

  return (
    <section data-testid="mirroring">
      <h2>Calendar mirroring</h2>
      <p class="status">
        Copy events from one calendar to another, so both show the same busy time.
      </p>
      <ul class="meta" data-testid="mirror-tips">
        <li>
          A copy goes away for good when you decline or delete the original event, or add #tl_nosync
          to it.
        </li>
        <li>
          Family calendar: copies of family events land on your work calendar. Decline the events
          that do not concern you, or ask your family to add #tl_nosync to them.
        </li>
        <li>
          Seeing each event twice? Your calendar app shows both the original and the copy. Hide the
          source calendar in your calendar app.
        </li>
      </ul>
      <PolicyForm
        key={`new-${created}`}
        testid="mirror-form"
        calendars={calendars}
        submit="Add mirroring"
        initial={{
          source: "",
          dest: "",
          visibility: fromLibrary ? "busy_only" : "label_only",
          calendarType: "personal",
          allDayMode: "none",
          color: "",
          outside: true,
        }}
        onSave={(f) =>
          void act(
            () => api("POST", "/api/mirrors", body(f)),
            () => setCreated((n) => n + 1),
          )
        }
      />
      {message && (
        <p class="status" role="status" data-testid="mirror-message">
          {message}
        </p>
      )}
      {ask && <Confirm ask={ask} onClose={() => setAsk(null)} />}
      <div class="field">
        <label for="mirror-no-reply">Copies of events you have not answered</label>
        <select
          id="mirror-no-reply"
          value={noReply ?? "free"}
          disabled={noReply === null}
          onChange={(e) => {
            const value = e.currentTarget.value as NoReply;
            const before = noReply;
            setNoReply(value);
            // A failed save shows the stored choice again.
            void act(() =>
              api("PATCH", "/api/settings", { noReplyCopies: value }).catch((err: unknown) => {
                setNoReply(before);
                throw err;
              }),
            );
          }}
        >
          <option value="free">Show as free</option>
          <option value="busy">Show as busy</option>
        </select>
        <p class="meta">Applies to every mirroring policy.</p>
      </div>
      <p class="meta">Each switch writes many events. Wait a few minutes between switches.</p>
      <p class="meta" data-testid="mirror-reconciled">
        Last full check:{" "}
        {reconciledAt === null ? "not yet" : toLocalInput(zone(), reconciledAt).replace("T", " ")}
      </p>
      <div class="actions" role="tablist" aria-label="Filter policies by account">
        {[{ id: null, email: "All" }, ...accounts].map((a) => (
          <button
            type="button"
            role="tab"
            key={a.id ?? "all"}
            aria-selected={tab === a.id}
            onClick={() => setTab(a.id)}
          >
            {a.email}
          </button>
        ))}
      </div>
      <div class="list" data-testid="mirror-list">
        {shown.map((p) => {
          const label = `${nameOf(p.source_calendar_id, p.source_name)} → ${nameOf(p.dest_calendar_id, p.dest_name)}`;
          return (
            <div key={p.id}>
              <div class="row" data-mirror={label}>
                <span>
                  {label} · {p.visibility.replace("_", " ")}
                  {p.enabled ? "" : " · off"}
                  {p.disconnected && (
                    <span class="status error" role="alert" data-testid="mirror-disconnected">
                      {" "}
                      · Paused: {p.disconnected} is disconnected. Reconnect it on the Account page.
                    </span>
                  )}
                </span>
                <div class="actions">
                  <button type="button" onClick={() => setEditing(editing === p.id ? null : p.id)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void act(() => api("PATCH", `/api/mirrors/${p.id}`, { enabled: !p.enabled }))
                    }
                  >
                    {p.enabled ? "Turn off" : "Turn on"}
                  </button>
                  <button
                    type="button"
                    class="danger"
                    onClick={() =>
                      setAsk({
                        title: "Delete mirroring policy",
                        text: "Delete this mirroring policy? Tempoloom removes its copies. This cannot be undone.",
                        action: "Delete policy",
                        onYes: () => void act(() => api("DELETE", `/api/mirrors/${p.id}`)),
                      })
                    }
                  >
                    Delete
                  </button>
                </div>
              </div>
              {editing === p.id && (
                <PolicyForm
                  testid="mirror-edit"
                  calendars={calendars}
                  submit="Save policy"
                  initial={{
                    source: p.source_calendar_id,
                    dest: p.dest_calendar_id,
                    visibility: p.visibility,
                    calendarType: p.calendar_type,
                    allDayMode: p.all_day_mode,
                    color: p.color_override ?? "",
                    outside: p.copy_outside_work_hours === 1,
                  }}
                  onSave={(f) =>
                    void act(
                      () => api("PUT", `/api/mirrors/${p.id}`, body(f)),
                      () => setEditing(null),
                    )
                  }
                  onCancel={() => setEditing(null)}
                />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
