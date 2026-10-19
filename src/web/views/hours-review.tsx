// First-run review of hours (docs/specs/planning-hours.md HRS-15): the work,
// meeting and personal hours in one dialog; Done records the review.
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import { loadMe, planNow } from "../lib/state.ts";
import { HoursEditor } from "./settings.tsx";

interface HoursSet {
  id: string;
  kind: string;
  name: string;
  weekly: Record<string, [number, number][]>;
}

export function HoursReview({ onClose }: { onClose: () => void }) {
  const [sets, setSets] = useState<HoursSet[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    void api<{ hours: HoursSet[] }>("GET", "/api/hours").then((h) =>
      setSets(h.hours.filter((s) => s.kind !== "custom")),
    );
  }, []);
  const done = async () => {
    await api("PATCH", "/api/settings", { hoursReviewed: true });
    await loadMe();
    onClose();
  };
  return (
    <div class="dialog-backdrop">
      <div
        class="dialog wide-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-title"
      >
        <h2 id="review-title">Review your hours</h2>
        <p class="status">
          Tempoloom places tasks and habits in work or personal hours, and meetings in meeting
          hours. Change them now if they are not right; you can also change them later in Settings.
        </p>
        {message && (
          <p class="status" data-testid="review-message">
            {message}
          </p>
        )}
        {sets?.map((s) => (
          <HoursEditor
            key={s.id}
            set={s}
            onSave={async (weekly) => {
              setMessage(null);
              await api("PUT", `/api/hours/${s.id}`, { weekly });
              await planNow();
              setMessage("Saved");
            }}
          />
        ))}
        <div class="actions">
          <button type="button" class="primary" onClick={() => void done()}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
