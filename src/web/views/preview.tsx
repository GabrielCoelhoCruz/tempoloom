// Preview mode (docs/specs/assistant-preview-mode.md): the switch, the staged
// changes with accept and discard, the final list, and the summary after apply.
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import { useLive } from "../lib/live.ts";
import { chatDraft, sidePanel } from "../lib/planner-signals.ts";
import { type OverlayItem, overlay } from "../lib/preview.ts";
import { onLinkClick } from "../lib/router.ts";

interface Change {
  id: string;
  source: string;
  sourceLabel: string;
  summary: string;
  description: string | null;
  reason: string;
  state: "pending" | "accepted";
  impact: string;
}

interface Data {
  on: boolean;
  byHand: boolean;
  changes: Change[];
  overlay: OverlayItem[];
}

interface ApplyResult {
  applied: { id: string; summary: string }[];
  stale: { id: string; summary: string; reason: string }[];
  failed: { id: string; summary: string; error: string }[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Loads the preview state again after each staged change, live signal and action. */
function usePreview(): [Data | null, () => Promise<void>] {
  const [data, setData] = useState<Data | null>(null);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    const d = await api<Data>("GET", "/api/preview");
    // A slower, older answer must not replace a newer one.
    if (n !== seq.current) return;
    setData(d);
  }, []);
  useEffect(() => {
    void load();
    const again = () => void load();
    addEventListener("tl-staged", again);
    return () => removeEventListener("tl-staged", again);
  }, [load]);
  useLive(load);
  return [data, load];
}

export function PreviewPanel({ onApplied }: { onApplied: () => void }) {
  const [data, load] = usePreview();
  const [review, setReview] = useState(false);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    overlay.value = data?.on ? data.overlay : [];
  }, [data]);
  useEffect(
    () => () => {
      overlay.value = [];
    },
    [],
  );

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    await load();
  };

  if (!data) return null;
  const n = data.changes.length;
  const apply = () =>
    act(async () => {
      setBusy(true);
      try {
        const r = await api<ApplyResult>("POST", "/api/preview/apply", {
          ids: data.changes.map((c) => c.id),
        });
        setResult(r);
        setReview(false);
        onApplied();
      } finally {
        setBusy(false);
      }
    });

  return (
    <section class="preview" data-testid="preview-panel">
      <div class="preview-head">
        <label class="inline">
          <input
            type="checkbox"
            checked={data.on}
            onChange={(e) => {
              const on = e.currentTarget.checked;
              void act(() => api("POST", "/api/preview/mode", { on }));
            }}
          />
          Preview mode
        </label>
        {data.on ? (
          <span class="status">
            Changes you make now are staged. Nothing reaches your calendar until you apply it.
          </span>
        ) : (
          n > 0 && (
            <span class="status" data-testid="preview-pending">
              {plural(n, "staged change is", "staged changes are")} pending. Turn preview mode on to
              review {n === 1 ? "it" : "them"}.
            </span>
          )
        )}
        {data.on && n > 0 && (
          <button type="button" class="primary" onClick={() => setReview(true)}>
            Review and apply changes
          </button>
        )}
      </div>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {data.on && n > 0 && (
        <div class="list" data-testid="staged-list">
          {data.changes.map((c) => (
            <div class="row" key={c.id} data-testid="staged-change">
              <div>
                <div>
                  <span class="badge">{c.state === "accepted" ? "Accepted" : "Pending"}</span>{" "}
                  <strong>{c.summary}</strong>
                </div>
                {c.description !== null && (
                  <pre
                    class="new-description"
                    title="New description"
                    data-testid="staged-description"
                  >
                    {c.description}
                  </pre>
                )}
                <div class="meta">
                  {c.sourceLabel} · {c.impact}
                  {c.reason ? ` · “${c.reason}”` : ""}
                </div>
              </div>
              <div class="actions">
                {c.state === "pending" && (
                  <button
                    type="button"
                    onClick={() => void act(() => api("POST", `/api/preview/${c.id}/accept`))}
                  >
                    Accept
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void act(() => api("POST", `/api/preview/${c.id}/discard`))}
                >
                  Discard
                </button>
                {c.source === "assistant_chat" && (
                  <button
                    type="button"
                    onClick={() => {
                      chatDraft.value = `About “${c.summary}”: `;
                      sidePanel.value = "assistant";
                    }}
                  >
                    Reply in chat
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {review && (
        <div class="dialog-backdrop">
          <div class="dialog" role="dialog" aria-label="Review and apply" data-testid="review-list">
            <h2>Review and apply</h2>
            <p class="status">
              Tempoloom writes these changes in this order and notifies guests now. Remove what you
              do not want.
            </p>
            {data.changes.length === 0 && <p class="status">Nothing left to apply.</p>}
            {data.changes.map((c) => (
              <div class="row" key={c.id} data-testid="review-item">
                <span>
                  {c.summary} <span class="meta">· {c.sourceLabel}</span>
                </span>
                <button
                  type="button"
                  onClick={() => void act(() => api("POST", `/api/preview/${c.id}/discard`))}
                >
                  Remove
                </button>
              </div>
            ))}
            <div class="actions">
              <button
                type="button"
                class="primary"
                disabled={busy || data.changes.length === 0}
                onClick={() => void apply()}
              >
                {busy ? "Applying…" : "Confirm and apply"}
              </button>
              <button type="button" onClick={() => setReview(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      {result && (
        <div class="apply-summary" role="status" data-testid="apply-summary">
          <strong>
            Applied {result.applied.length} · Skipped as stale {result.stale.length} · Failed{" "}
            {result.failed.length}
          </strong>
          <ul>
            {result.stale.map((s) => (
              <li key={s.id}>
                Skipped: {s.summary}. {s.reason}.
              </li>
            ))}
            {result.failed.map((f) => (
              <li key={f.id}>
                Failed: {f.summary}. {f.error}
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => setResult(null)}>
            Dismiss
          </button>
        </div>
      )}
    </section>
  );
}

/** On other pages: preview mode is on, and how many changes wait in the planner. */
export function PreviewBanner() {
  const [data] = usePreview();
  if (!data?.on) return null;
  return (
    <div class="preview-banner" role="status" data-testid="preview-banner">
      Preview mode is on · {plural(data.changes.length, "staged change", "staged changes")} ·{" "}
      <a href="/" onClick={onLinkClick}>
        Review in the planner
      </a>
    </div>
  );
}
