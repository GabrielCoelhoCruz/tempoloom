// The planner's side panel: the Issues tab of meeting checks
// (automations-meeting-quality.md rule 6) and the recommendations list
// (platform-current-version.md rule 5). It loads with the planner, on demand.
import { useCallback, useEffect, useState } from "preact/hooks";
import type { Recommendation } from "../../server/api/meeting-checks.ts";
import type { Issue } from "../../server/meeting-checks.ts";
import { api } from "../lib/api.ts";
import { dateTimeText } from "../lib/format.ts";
import { useLive } from "../lib/live.ts";
import { messageOf } from "../lib/save.ts";
import { zone } from "../lib/state.ts";

const CHECK_LABELS: Record<Issue["checkId"], string> = {
  conflict: "Conflict",
  attendee_availability: "Attendee",
  rsvp_reminder: "No answer",
  video_link: "No video link",
  agenda: "No agenda",
  company: "Company check",
};

export function IssuesPanel() {
  const z = zone();
  const [tab, setTab] = useState<"issues" | "recommendations">("issues");
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [draftFor, setDraftFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [i, r] = await Promise.all([
      api<{ issues: Issue[] }>("GET", "/api/meeting-checks/issues"),
      api<{ recommendations: Recommendation[] }>("GET", "/api/meeting-checks/recommendations"),
    ]);
    setIssues(i.issues);
    setRecs(r.recommendations);
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);
  useLive(load);

  const act = (fn: () => Promise<unknown>) => {
    setError(null);
    fn().then(load, (err) => setError(messageOf(err)));
  };
  const ignore = (i: Issue, scope: "event" | "series") =>
    act(() =>
      api("POST", "/api/meeting-checks/ignore", {
        ignoreId: i.ignoreId,
        scope,
        target: scope === "event" ? i.eventKey : i.seriesId,
      }),
    );

  return (
    <section class="side-panel" data-testid="side-panel">
      <div class="actions" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "issues"}
          onClick={() => setTab("issues")}
        >
          Issues ({issues?.length ?? 0})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "recommendations"}
          onClick={() => setTab("recommendations")}
        >
          Recommendations ({recs.length})
        </button>
      </div>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {tab === "issues" ? (
        <div class="list" data-testid="checks-issues">
          {issues?.length === 0 && <p class="status">No open issues in the next 7 days.</p>}
          {issues?.map((i) => {
            const id = `${i.ignoreId}|${i.eventKey}`;
            return (
              <div class="row" key={id} data-testid="issue" data-check={i.checkId}>
                <div>
                  <div>
                    <span class="badge">
                      {i.checkId === "company" ? "🔒 " : ""}
                      {CHECK_LABELS[i.checkId]}
                    </span>{" "}
                    {i.title} · {dateTimeText(z, i.start)}
                  </div>
                  <div class="meta">{i.message}</div>
                  {draftFor === id && i.draft && (
                    <pre class="meta" data-testid="agenda-draft">
                      {i.draft}
                    </pre>
                  )}
                </div>
                <div class="actions">
                  {i.checkId === "agenda" &&
                    (draftFor === id ? (
                      <button
                        type="button"
                        class="primary"
                        onClick={() =>
                          act(() =>
                            api("POST", "/api/meeting-checks/agenda", { eventKey: i.eventKey }),
                          )
                        }
                      >
                        Apply draft
                      </button>
                    ) : (
                      <button type="button" onClick={() => setDraftFor(id)}>
                        Draft agenda
                      </button>
                    ))}
                  <button type="button" onClick={() => ignore(i, "event")}>
                    Ignore this event
                  </button>
                  {i.seriesId && (
                    <button type="button" onClick={() => ignore(i, "series")}>
                      Ignore the series
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div class="list" data-testid="recommendations">
          {recs.length === 0 && <p class="status">Nothing to recommend.</p>}
          {recs.map((r, n) => (
            <div class="row" key={`${r.kind}-${n}`} data-kind={r.kind}>
              {r.text}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
