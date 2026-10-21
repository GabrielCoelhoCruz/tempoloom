// The user task defaults in Settings (docs/specs/planning-tasks.md "User task
// defaults", TSK-1 to TSK-3; planning-event-content.md CNT-20). A change
// applies to tasks created after it. The time between chunks is in Scheduling.
import type { Settings as UserSettings } from "../../server/settings.ts";
import { api } from "../lib/api.ts";
import { useCommit } from "../lib/commit-input.ts";
import { LEVEL_NAMES } from "../lib/state.ts";

type Defaults = UserSettings["taskDefaults"];

export function TaskDefaults({
  settings,
  hours,
  act,
}: {
  settings: UserSettings;
  hours: { id: string; kind: string; name: string }[];
  act: (fn: () => Promise<unknown>) => Promise<boolean>;
}) {
  const d = settings.taskDefaults;
  const save = (patch: Partial<Defaults>) =>
    act(() => api("PATCH", "/api/settings", { taskDefaults: patch }));
  const minutes = (value: string) => Math.max(15, Math.round(Number(value) / 15) * 15);
  const duration = useCommit(d.minutes, (v) => save({ minutes: minutes(v) }));
  const minChunk = useCommit(d.minChunkMinutes, (v) => save({ minChunkMinutes: minutes(v) }));
  const maxChunk = useCommit(d.maxChunkMinutes, (v) => save({ maxChunkMinutes: minutes(v) }));
  const startDelay = useCommit(d.startDelayMinutes, (v) =>
    save({ startDelayMinutes: Math.max(0, Math.round(Number(v))) }),
  );
  const dueIn = useCommit(d.dueInDays ?? "", (v) =>
    save({ dueInDays: v === "" ? null : Math.max(1, Math.round(Number(v))) }),
  );
  return (
    <section data-testid="task-defaults">
      <h2>Task defaults</h2>
      <p class="meta">New tasks start with these values. Tasks you already have keep theirs.</p>
      <div class="form">
        <label>
          Priority
          <select value={d.level} onChange={(e) => save({ level: Number(e.currentTarget.value) })}>
            {[1, 2, 3, 4].map((l) => (
              <option value={l} key={l}>
                {LEVEL_NAMES[l]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Duration (minutes)
          <input type="number" min={15} step={15} {...duration} />
        </label>
        <label>
          Split into chunks
          <select
            value={d.splitUp ? "yes" : "no"}
            onChange={(e) => save({ splitUp: e.currentTarget.value === "yes" })}
          >
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
        {d.splitUp && (
          <>
            <label>
              Shortest chunk
              <input type="number" min={15} step={15} {...minChunk} />
            </label>
            <label>
              Longest chunk
              <input type="number" min={15} step={15} {...maxChunk} />
            </label>
          </>
        )}
        <label>
          Hours
          <select
            value={d.hoursSetId ?? ""}
            onChange={(e) => save({ hoursSetId: e.currentTarget.value || null })}
          >
            <option value="">Work hours</option>
            {hours
              .filter((h) => h.kind !== "work")
              .map((h) => (
                <option value={h.id} key={h.id}>
                  {h.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Start delay (minutes)
          <input type="number" min={0} step={15} {...startDelay} />
        </label>
        <label>
          Due in (days)
          <input type="number" min={1} placeholder="No due date" {...dueIn} />
        </label>
        <label>
          Visibility
          <select
            value={d.visibility}
            onChange={(e) => save({ visibility: e.currentTarget.value as Defaults["visibility"] })}
          >
            <option value="calendar_default">Calendar default</option>
            <option value="private">Private</option>
          </select>
        </label>
        <label class="inline">
          <input
            type="checkbox"
            defaultChecked={d.nextUp}
            onChange={(e) => save({ nextUp: e.currentTarget.checked })}
          />
          Next up (work on it first)
        </label>
      </div>
    </section>
  );
}
