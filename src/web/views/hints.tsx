// Onboarding hints in the planner, shown until the user dismisses them. The
// advice to turn off other scheduling tools first (platform-current-version.md rule 17).
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import { onLinkClick } from "../lib/router.ts";

export function PlannerHints() {
  const [hints, setHints] = useState<string[] | null>(null);
  useEffect(() => {
    void api<{ hints: string[] }>("GET", "/api/hints").then((h) => setHints(h.hints));
  }, []);
  const dismiss = (hint: string) => {
    setHints((list) => (list ?? []).filter((h) => h !== hint));
    void api("POST", `/api/hints/${hint}/dismiss`);
  };
  return (
    <div data-testid="planner-hints" data-loaded={hints !== null}>
      {hints?.includes("other-tools") && (
        <p class="hint" role="note" data-testid="hint-other-tools">
          Before Tempoloom plans your week, turn off any other scheduling tool that writes to these
          calendars, so the two tools do not create competing events.{" "}
          <a href="/help/other-tools" onClick={onLinkClick}>
            Why
          </a>{" "}
          <button type="button" onClick={() => dismiss("other-tools")}>
            Got it
          </button>
        </p>
      )}
    </div>
  );
}
