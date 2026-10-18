// Team settings > Webhooks (docs/specs/integrations-webhooks.md rules 1-6, 15, 24):
// admins create, edit and delete the team's endpoints; members see them and
// attach them to their own booking links on the Booking links page.
import { useCallback, useEffect, useState } from "preact/hooks";
import { ApiError, api } from "../lib/api.ts";

interface Endpoint {
  id: string;
  name: string;
  url: string;
  status: "active" | "suspended";
  link_ids: string[];
  last_result: string | null;
}

const VERIFY_EXAMPLE = `import { createHmac, timingSafeEqual } from "node:crypto";

// rawBody: the request body as received, before JSON parsing.
function verified(rawBody, header, secret) {
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("base64");
  const a = Buffer.from(header ?? ""), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
// header: request.headers["x-tempoloom-signature-256"]`;

export function TeamWebhooks() {
  const [data, setData] = useState<{ endpoints: Endpoint[]; canManage: boolean } | null>(null);
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setData(await api<{ endpoints: Endpoint[]; canManage: boolean }>("GET", "/api/webhooks"));
  }, []);
  useEffect(() => void load(), [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(String((err as ApiError).body ? JSON.stringify((err as ApiError).body) : err));
    }
  };

  if (!data) return null;
  const { endpoints, canManage } = data;
  return (
    <section data-testid="team-webhooks">
      <h2>Webhooks</h2>
      <p>
        Tempoloom sends a signed POST request to these addresses when a meeting is booked, moved or
        cancelled through a booking link that uses them. Members choose the endpoints of each of
        their links on the Booking links page.
      </p>
      {canManage && !adding && (
        <button type="button" onClick={() => setAdding(true)}>
          + New
        </button>
      )}
      {canManage && adding && (
        <form
          class="form"
          data-testid="webhook-form"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget as HTMLFormElement;
            const f = new FormData(form);
            const name = String(f.get("name") ?? "");
            const typed = String(f.get("secret") ?? "");
            setUrlError(null);
            api<{ secret: string }>("POST", "/api/webhooks", {
              name,
              url: String(f.get("url") ?? ""),
              ...(typed ? { secret: typed } : {}),
            })
              .then((r) => {
                setSecret({ name, value: r.secret });
                form.reset();
                return load();
              })
              .catch((err) => {
                const body =
                  err instanceof ApiError
                    ? (err.body as { message?: string; issues?: { message: string }[] })
                    : null;
                setUrlError(body?.message ?? body?.issues?.[0]?.message ?? String(err));
              });
          }}
        >
          <label>
            Name
            <input name="name" required maxLength={100} />
          </label>
          <label class="wide">
            URL
            <input name="url" required placeholder="https://example.com/hooks/tempoloom" />
            {urlError && (
              <span class="error" data-testid="webhook-url-error">
                {urlError}
              </span>
            )}
          </label>
          <label>
            Secret (optional, 32 to 128 characters)
            <input name="secret" minLength={32} maxLength={128} />
          </label>
          <button type="submit" class="primary">
            Add webhook
          </button>
        </form>
      )}
      {secret && (
        <p class="status" data-testid="webhook-secret-box">
          Secret for {secret.name}: <code data-testid="webhook-secret">{secret.value}</code>{" "}
          <button type="button" onClick={() => void navigator.clipboard?.writeText(secret.value)}>
            Copy secret
          </button>
          <br />
          Copy it now. Tempoloom does not show it again. Update your receiver when you change it.
        </p>
      )}
      {error && <p class="error">{error}</p>}
      <div class="list" data-testid="webhook-list">
        {endpoints.map((e) => (
          <div class="row" key={e.id} data-testid="webhook-row">
            <div>
              <div>
                {e.name} <span class="badge">{e.status}</span>
              </div>
              <div class="meta">
                {e.url} · {e.link_ids.length} links
                {e.last_result ? ` · last result ${e.last_result.replace("http_", "HTTP ")}` : ""}
              </div>
            </div>
            {canManage && (
              <div class="actions">
                {e.status === "suspended" && (
                  <button
                    type="button"
                    onClick={() => void act(() => api("POST", `/api/webhooks/${e.id}/resume`))}
                  >
                    Resume
                  </button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    void act(async () => {
                      const r = await api<{ secret: string }>(
                        "POST",
                        `/api/webhooks/${e.id}/secret`,
                      );
                      setSecret({ name: e.name, value: r.secret });
                    })
                  }
                >
                  New secret
                </button>
                <button
                  type="button"
                  class="danger"
                  onClick={() => void act(() => api("DELETE", `/api/webhooks/${e.id}`))}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        ))}
        {endpoints.length === 0 && <p class="status">No webhooks yet.</p>}
      </div>
      <details>
        <summary>Check the signature in your receiver</summary>
        <pre data-testid="verify-example">{VERIFY_EXAMPLE}</pre>
      </details>
    </section>
  );
}
