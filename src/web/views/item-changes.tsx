// The change log of one item (docs/specs/planning-scheduler.md SCH-119): what
// the plan runs of the last 30 days did to its events, and why (SCH-116 codes).
import { useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import { dateText } from "../lib/format.ts";

interface Change {
  at: string;
  action: "placed" | "moved" | "removed" | "skipped" | "conflict" | "status";
  from: string;
  to: string;
  /** The first day of a skipped period. */
  period: string;
  reason: string;
}

const ACTIONS: Record<Change["action"], string> = {
  placed: "placed",
  moved: "moved",
  removed: "removed",
  skipped: "skipped",
  conflict: "kept as conflict",
  status: "status changed",
};

const AWAY = "time away (all-day or out-of-office events) fills the period";
const REASONS: Record<string, string> = {
  "outside-window": "outside the planning window",
  "no-hours": "no hours in that time",
  "no-hours-overlap": "no time inside everyone's meeting hours",
  "too-long-for-hours": "longer than any range of its hours",
  away: AWAY,
  "all-day-block": AWAY,
  "reserved-word": "an event with a skip word is in the period",
  "no-common-time": "no time when all attendees are free",
  "move-limit": "the move limit stops the move",
  "budget-reached": "the move limit stops the move",
  "policy-none": "automatic moves are off",
  "locked-conflict": "it is locked, so it keeps its time",
  "no-space-fixed": "other events take that time",
  "no-space-priority": "higher-priority items take that time",
  "after-due": "some work ends after the due date",
  "rules-changed": "its settings changed",
  rearranged: "the plan changed around it",
  snoozed: "you snoozed it",
  "time-used-done": "its time was used for the wait days, so it is done",
  "time-used-readd": "its time was used for the wait days, so its time was added again",
};

export function ItemChanges({ kind, id }: { kind: string; id: string }) {
  const [changes, setChanges] = useState<Change[] | null>(null);
  return (
    <details
      class="meta"
      data-testid="item-changes"
      onToggle={(e) => {
        if (!e.currentTarget.open) return;
        setChanges(null);
        void api<{ changes: Change[] }>("GET", `/api/items/${kind}/${id}/changes`).then((r) =>
          setChanges(r.changes),
        );
      }}
    >
      <summary>Change log</summary>
      {changes === null ? (
        <p class="status">Loading…</p>
      ) : changes.length === 0 ? (
        <p class="status">No changes in the last 30 days.</p>
      ) : (
        <ul>
          {changes.map((c, i) => (
            <li
              key={`${c.at}-${i}`}
              data-testid="item-change"
              data-action={c.action}
              data-reason={c.reason}
            >
              {c.at} · {ACTIONS[c.action] ?? c.action}
              {c.from ? ` · ${c.from}` : ""}
              {c.to ? (c.from ? ` → ${c.to}` : ` · ${c.to}`) : ""}
              {!c.from && !c.to && c.period ? ` · period of ${dateText(c.period)}` : ""}
              {c.reason ? ` · ${REASONS[c.reason] ?? c.reason}` : ""}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
