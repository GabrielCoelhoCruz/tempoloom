// The weekly report email switch (docs/specs/analytics-weekly-reports.md rules 1-2).
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.ts";

export function WeeklyReportSetting() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    void api<{ enabled: boolean }>("GET", "/api/weekly-report").then((r) => setEnabled(r.enabled));
  }, []);
  if (enabled === null) return null;
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
              setSaved(false);
              void api("PUT", "/api/weekly-report", { enabled: next }).then(() => setSaved(true));
            }}
          />
          Weekly report email
        </label>
        {saved && (
          <span class="status" data-testid="weekly-report-saved">
            Saved
          </span>
        )}
      </div>
    </section>
  );
}
