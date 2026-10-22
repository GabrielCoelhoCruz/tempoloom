export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super(`API error ${status}`);
    this.status = status;
    this.body = body;
  }
}

/** Identifies this page, so live updates skip the changes it made itself. */
export const CLIENT_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

/** The GETs of one URL: how many started and are on their way, and the newest answer so far. */
interface Gets {
  started: number;
  pending: number;
  done: { seq: number; answer: () => unknown } | null;
}

/** One entry per URL with a GET on its way; the entry goes when the last one ends. */
const gets = new Map<string, Gets>();

/** The URLs with a GET on its way (for the tests). */
export const getsInFlight = () => gets.size;

/** An answer of the server; a network error or a 5xx is no answer and never wins. */
const answered = (err: unknown) => err instanceof ApiError && err.status < 500;

/**
 * Sends a request. A GET gives the answer of the newest GET of the same URL
 * that has ended: an older answer that comes after a newer one gives the newer
 * one (also a newer 401 or 404), so a page that read its data again (a live
 * update, then its own save) never shows the older data. A GET never waits for
 * a newer one: the newest answer already there is used.
 */
export function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  if (method !== "GET") return send<T>(method, url, body);
  const g = gets.get(url) ?? { started: 0, pending: 0, done: null };
  gets.set(url, g);
  const seq = ++g.started;
  g.pending++;
  const end = (answer: () => T, counts: boolean): T => {
    if (counts && (g.done === null || g.done.seq < seq)) g.done = { seq, answer };
    if (--g.pending === 0) gets.delete(url);
    return (g.done && g.done.seq > seq ? g.done.answer : answer)() as T;
  };
  return send<T>(method, url, body).then(
    (data) => end(() => data, true),
    (err: unknown) =>
      end(() => {
        throw err;
      }, answered(err)),
  );
}

async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      "x-tl-client": CLIENT_ID,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  // The owner removed this delegate's access: reload in the own account (delegated access rule 10).
  if (res.status === 403 && (data as { error?: string } | undefined)?.error === "acting_ended")
    location.assign("/?acting_ended=1");
  if (!res.ok) throw new ApiError(res.status, data);
  // Preview mode staged the change instead of saving it (assistant-preview-mode.md).
  if (res.status === 202 && (data as { staged?: unknown } | undefined)?.staged)
    dispatchEvent(new Event("tl-staged"));
  return data as T;
}
