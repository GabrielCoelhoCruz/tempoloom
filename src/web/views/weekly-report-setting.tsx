// The weekly report email switch (docs/specs/analytics-weekly-reports.md rules 1-2),
// with the other emails of settings. It is one of the user's email preferences.
// Below it, the weeks the user shared (rules 10-12), each with Stop sharing.
import { useEffect, useState } from "preact/hooks";
import type { MeetingPrefs } from "../../server/meeting-prefs.ts";
import { api } from "../lib/api.ts";
import { messageOf } from "../lib/save.ts";

interface SharedWeek {
  id: string;
  weekFrom: string;
  weekTo: string;
  url: string;
}

function SharedWeeks() {
  const [shares, setShares] = useState<SharedWeek[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    api<{ shares: SharedWeek[] }>("GET", "/api/weekly-shares").then(
      (r) => setShares(r.shares),
      (err) => setError(messageOf(err)),
    );
  useEffect(() => {
    void load();
  }, []);
  if (!shares?.length && !error) return null;
  return (
    <div data-testid="shared-weeks">
      <h3>Shared weeks</h3>
      <div class="list">
        {(shares ?? []).map((s) => (
          <div class="row" key={s.id} data-testid="shared-week">
            <span>
              <a href={s.url} target="_blank" rel="noopener noreferrer">
                {s.weekFrom} to {s.weekTo}
              </a>
            </span>
            <div class="actions">
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  api("POST", `/api/weekly-shares/${encodeURIComponent(s.id)}/stop`).then(
                    () => void load(),
                    (err) => setError(messageOf(err)),
                  );
                }}
              >
                Stop sharing
              </button>
            </div>
          </div>
        ))}
      </div>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function WeeklyReportSetting() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [state, setState] = useState<"idle" | "saved" | { error: string }>("idle");
  useEffect(() => {
    api<{ prefs: MeetingPrefs }>("GET", "/api/meeting-checks").then(
      (r) => setEnabled(r.prefs.weeklyReport),
      (err) => setState({ error: messageOf(err) }),
    );
  }, []);
  if (enabled === null)
    return typeof state === "object" ? (
      <p class="error" role="alert">
        {state.error}
      </p>
    ) : null;
  return (
    <section data-testid="weekly-report">
      <h2>Weekly report</h2>
      <p class="meta">
        In the first hour of your last workday, an email with the week's meetings, solo work,
        personal time and calendar facts.
      </p>
      <div class="actions">
        <label class="inline">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => {
              const next = e.currentTarget.checked;
              setEnabled(next);
              setState("idle");
              api<{ prefs: MeetingPrefs }>("PATCH", "/api/meeting-prefs", {
                weeklyReport: next,
              }).then(
                (r) => {
                  setEnabled(r.prefs.weeklyReport);
                  setState("saved");
                },
                (err) => {
                  setEnabled(!next);
                  setState({ error: messageOf(err) });
                },
              );
            }}
          />
          Weekly report email
        </label>
        {state === "saved" && (
          <span class="status" data-testid="weekly-report-saved">
            Saved
          </span>
        )}
      </div>
      {typeof state === "object" && (
        <p class="error" role="alert">
          {state.error}
        </p>
      )}
      <SharedWeeks />
    </section>
  );
}
