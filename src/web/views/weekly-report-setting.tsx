// The weekly report email switch (docs/specs/analytics-weekly-reports.md rules 1-2),
// with the other emails of settings. It is one of the user's email preferences.
import { useEffect, useState } from "preact/hooks";
import type { MeetingPrefs } from "../../server/meeting-prefs.ts";
import { api } from "../lib/api.ts";
import { messageOf } from "../lib/save.ts";

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
    </section>
  );
}
