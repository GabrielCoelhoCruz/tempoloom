// A task from a time range picked in the planner (docs/specs/planning-tasks.md
// TSK-7): its length is the range, and its one chunk is locked there.
import "./parts.css";
import { useLayoutEffect, useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import { formatWhen } from "../lib/format.ts";
import { planNow, zone } from "../lib/state.ts";

export function TaskHereDialog({
  start,
  end,
  onClose,
}: {
  start: number;
  end: number;
  onClose: (created: boolean) => void;
}) {
  const z = zone();
  const [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose(false);
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [onClose]);
  const create = (e: Event) => {
    e.preventDefault();
    const title = String(new FormData(e.currentTarget as HTMLFormElement).get("title") ?? "");
    setError(null);
    void api("POST", "/api/tasks/at", { title, start, end })
      .then(() => planNow())
      .then(() => onClose(true))
      .catch((err: unknown) => {
        const body = (err as { body?: { message?: string } }).body;
        setError(body?.message ?? (err instanceof Error ? err.message : String(err)));
      });
  };
  return (
    <div class="dialog-backdrop">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="task-here-title">
        <h2 id="task-here-title">Task at this time</h2>
        <p class="status" data-testid="task-here-time">
          {formatWhen(z, start)} – {formatWhen(z, end)}, locked there
        </p>
        <form class="form" onSubmit={create}>
          <label class="wide">
            Title
            {/* biome-ignore lint/a11y/noAutofocus: the dialog opens to type a title */}
            <input name="title" required maxLength={255} autoFocus />
          </label>
          <button type="submit" class="primary">
            Create task
          </button>
          <button type="button" onClick={() => onClose(false)}>
            Cancel
          </button>
        </form>
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
