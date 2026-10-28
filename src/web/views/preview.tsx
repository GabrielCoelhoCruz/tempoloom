// Preview mode (docs/specs/assistant-preview-mode.md): the switch, the staged
// changes with accept and discard, the final list, and the summary after apply.
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import { useLive } from "../lib/live.ts";
import { chatDraft, sidePanel } from "../lib/planner-signals.ts";
import { type OverlayItem, overlay, reviewable } from "../lib/preview.ts";
import { onLinkClick } from "../lib/router.ts";
import "./pages.css";

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
    reviewable.value = !!data?.on && data.changes.length > 0;
  }, [data]);
  useEffect(
    () => () => {
      overlay.value = [];
      reviewable.value = false;
    },
    [],
  );
  // CMP-43: Escape and a press outside close the apply summary and the error.
  const popped = !!(result || error);
  useEffect(() => {
    if (!popped) return;
    const close = (e: Event) => {
      if (
        e instanceof KeyboardEvent
          ? e.key === "Escape"
          : !(e.target as Element).closest(".preview-pop")
      ) {
        setResult(null);
        setError(null);
      }
    };
    addEventListener("keydown", close);
    addEventListener("pointerdown", close);
    return () => {
      removeEventListener("keydown", close);
      removeEventListener("pointerdown", close);
    };
  }, [popped]);

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

  const ON = "Changes you make now are staged. Nothing reaches your calendar until you apply it.";
  const pending = `${plural(n, "staged change is", "staged changes are")} pending. Turn preview mode on to review ${n === 1 ? "it" : "them"}.`;
  const list = data.on && n > 0;
  return (
    // LAY-13: the panel is in the planner toolbar; its sentence shortens first.
    <section class="preview" data-testid="preview-panel" data-on={data.on || undefined}>
      <label class="inline">
        <input
          type="checkbox"
          class="switch"
          checked={data.on}
          onChange={(e) => {
            const on = e.currentTarget.checked;
            void act(() => api("POST", "/api/preview/mode", { on }));
          }}
        />
        Preview mode
      </label>
      {data.on ? (
        <span class="status" title={ON}>
          {ON}
        </span>
      ) : (
        n > 0 && (
          <span class="status" data-testid="preview-pending" title={pending}>
            {pending}
          </span>
        )
      )}
      {/* LAY-13: the staged list with its review button, the apply summary and the error
          open below the panel, so the toolbar keeps one row. */}
      {(list || result || error) && (
        <div class="popover preview-pop">
          {list && (
            <button type="button" class="primary" onClick={() => setReview(true)}>
              Review and apply changes
            </button>
          )}
          {error && (
            <p class="error" role="alert">
              {error}
            </p>
          )}
          {list && (
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
        </div>
      )}
      {review && (
        <div class="dialog-backdrop">
          <div
            class="dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Review and apply"
            data-testid="review-list"
          >
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
    </section>
  );
}

/** On other pages: preview mode is on, and how many changes wait in the planner. */
export function PreviewBanner() {
  const [data] = usePreview();
  if (!data?.on) return null;
  const text = `Preview mode is on · ${plural(data.changes.length, "staged change", "staged changes")}`;
  return (
    <div class="note accent" role="status" data-testid="preview-banner">
      <span class="note-text" title={text}>
        {text}
      </span>
      <span class="note-actions">
        <a href="/" onClick={onLinkClick}>
          Review in the planner
        </a>
      </span>
    </div>
  );
}
