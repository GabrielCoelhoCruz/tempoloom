// The New task form from any page (docs/specs/planning-tasks.md TSK-5,
// TSK-6): opened with the New task button or the key C. With "Create
// another" on, the form stays open after each save.
import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import { plannerReload } from "../lib/planner-signals.ts";
import { TaskForm } from "./tasks.tsx";

const KEY = "tempoloom.createAnother";

export function NewTaskDialog({ onClose }: { onClose: () => void }) {
  const [another, setAnother] = useState(() => localStorage.getItem(KEY) === "1");
  const [created, setCreated] = useState<string[]>([]);
  // Listen at once, not after paint: an Escape right after opening must close the form.
  useLayoutEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [onClose]);
  useEffect(() => {
    (
      document.querySelector('[role="dialog"] input[name="title"]') as HTMLInputElement | null
    )?.focus();
  }, []);
  return (
    <div class="dialog-backdrop">
      <div
        class="dialog wide-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-task-title"
      >
        <h2 id="new-task-title">New task</h2>
        <TaskForm
          onSaved={(title) => {
            plannerReload.value++;
            if (another) setCreated((list) => [...list, title]);
            else onClose();
          }}
        >
          <label class="inline">
            <input
              type="checkbox"
              checked={another}
              onChange={(e) => {
                const on = e.currentTarget.checked;
                localStorage.setItem(KEY, on ? "1" : "0");
                setAnother(on);
              }}
            />
            Create another
          </label>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </TaskForm>
        {created.length > 0 && (
          <p class="status" data-testid="created">
            Created {created.join(", ")}.
          </p>
        )}
      </div>
    </div>
  );
}
