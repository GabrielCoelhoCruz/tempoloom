// Connected calendars on the Settings page (docs/specs/accounts-connected-calendars.md
// rules 1-8, 28-30): which calendars count for availability, their category,
// calendars shared by URL, holiday feeds (events-out-of-office.md rule 11),
// and how connected calendars differ from mirroring.
import { useEffect, useState } from "preact/hooks";
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
import { me, planNow } from "../lib/state.ts";

const CATEGORIES = [
  ["business", "Business"],
  ["personal", "Personal"],
  ["travel", "Travel"],
] as const;

function meta(c: CalendarRow): string {
  if (c.provider === "ics") return "holiday feed";
  return [c.provider, c.email, c.main ? "main" : "", c.shared ? "shared" : ""]
    .filter(Boolean)
    .join(", ");
}

/** Moves the focus to the form for a new mirroring policy (rule 29). */
function newPolicy() {
  const first = document.querySelector<HTMLSelectElement>(
    '[data-testid="mirror-form"] select[name="source"]',
  );
  first?.scrollIntoView({ block: "center" });
  first?.focus();
}

export function CalendarSettings() {
  const [message, setMessage] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  useEffect(() => void loadCalendars(), []);
  const calendars = calendarList.value;
  const accounts = (me.value?.accounts ?? []).filter((a) => a.provider === "caldav" && !a.viaGrant);

  const act = async (fn: () => Promise<unknown>, done: string | null) => {
    setMessage(null);
    try {
      await fn();
      await loadCalendars();
      setMessage(done);
      await planNow();
    } catch (err) {
      await loadCalendars();
      setMessage(failure(err));
    }
  };
  const update = (id: string, change: Partial<CalendarRow>) => {
    calendarList.value = calendarList.value.map((x) => (x.id === id ? { ...x, ...change } : x));
  };

  return (
    <section data-testid="calendars">
      <h2>Calendars</h2>
      <p class="status">Checked calendars count for availability.</p>
      <div class="meta" data-testid="calendars-help">
        <p>
          <strong>Connected calendars:</strong> Tempoloom plans around their events. Other people do
          not see them.
        </p>
        <p>
          <strong>Mirroring:</strong> Tempoloom copies the busy time into another calendar, so
          people who book time on that calendar see it. Use it when other people book time directly
          on your calendar.
        </p>
      </div>
      <div class="actions">
        <button
          type="button"
          onClick={() =>
            void act(() => api("POST", "/api/calendars/refresh"), "Calendar list updated")
          }
        >
          Refresh calendar list
        </button>
        <button type="button" onClick={newPolicy}>
          New mirroring policy
        </button>
      </div>
      {message && (
        <p class="status" role="status" data-testid="calendars-message">
          {message}
        </p>
      )}
      {ask && <Confirm ask={ask} onClose={() => setAsk(null)} />}
      <div class="list" data-testid="calendar-list">
        {calendars.map((c) => {
          const name = displayName(c, calendars);
          return (
            <div class="row" key={c.id} data-calendar={c.name}>
              <label class="inline">
                <span>
                  {name} <span class="meta">({meta(c)})</span>
                </span>
                <input
                  type="checkbox"
                  checked={c.check_availability === 1}
                  disabled={c.locked === 1}
                  title={c.locked ? "Always connected" : undefined}
                  onChange={(e) => {
                    const checked = e.currentTarget.checked;
                    // Show the choice at once; a refusal reloads the list from the server.
                    update(c.id, { check_availability: checked ? 1 : 0 });
                    void act(
                      () => api("PATCH", `/api/calendars/${c.id}`, { checkAvailability: checked }),
                      null,
                    );
                  }}
                />
              </label>
              {c.check_availability === 1 && c.provider !== "ics" && (
                <select
                  aria-label={`Category of ${name}`}
                  value={c.category}
                  onChange={(e) => {
                    const category = e.currentTarget.value as CalendarRow["category"];
                    update(c.id, { category });
                    void act(() => api("PATCH", `/api/calendars/${c.id}`, { category }), null);
                  }}
                >
                  {CATEGORIES.map(([value, label]) => (
                    <option value={value} key={value}>
                      {label}
                    </option>
                  ))}
                </select>
              )}
              {c.provider === "ics" && (
                <button
                  type="button"
                  class="danger"
                  onClick={() =>
                    setAsk({
                      title: "Remove holiday feed",
                      text: `Remove ${c.name}? Its days stop blocking time.`,
                      action: "Remove feed",
                      onYes: () =>
                        void act(
                          () => api("DELETE", `/api/accounts/${c.account_id}`),
                          "Holiday feed removed.",
                        ),
                    })
                  }
                >
                  Remove feed
                </button>
              )}
            </div>
          );
        })}
      </div>

      {accounts.length > 0 && (
        <form
          class="form"
          data-testid="shared-calendar-form"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget as HTMLFormElement;
            const f = new FormData(form);
            void act(async () => {
              await api("POST", `/api/accounts/${String(f.get("account"))}/shared-calendars`, {
                url: String(f.get("url") ?? "").trim(),
              });
              form.reset();
            }, "Calendar added.");
          }}
        >
          <p class="meta wide">
            Did someone share a calendar with you? Add it by its address. Tempoloom needs read and
            write access to it.
          </p>
          <label>
            Account
            <select name="account">
              {accounts.map((a) => (
                <option value={a.id} key={a.id}>
                  {a.email}
                </option>
              ))}
            </select>
          </label>
          <label>
            Calendar URL
            <input name="url" type="url" required placeholder="https://dav.example.com/…" />
          </label>
          <button type="submit">Add shared calendar</button>
        </form>
      )}

      <form
        class="form"
        data-testid="holiday-feed-form"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget as HTMLFormElement;
          const url = String(new FormData(form).get("url") ?? "").trim();
          void act(async () => {
            await api("POST", "/api/holiday-feeds", { url });
            form.reset();
          }, "Holiday feed added.");
        }}
      >
        <p class="meta wide">
          Tempoloom does not read built-in public holiday calendars. Add a holiday feed (an
          iCalendar address) with the days you take off: its days block time like time away.
        </p>
        <label>
          Holiday feed URL
          <input name="url" required placeholder="https://example.com/holidays.ics" />
        </label>
        <button type="submit">Add holiday feed</button>
      </form>
    </section>
  );
}
