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

/** The answer of the newest GET of each URL (one entry per URL the page read). */
const newest = new Map<string, Promise<unknown>>();

/**
 * Sends a request. A GET whose answer comes after a newer GET of the same URL
 * started gives the newer answer: a page that read its data again (a live
 * update, then its own save) never shows an older answer that came last.
 */
export function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  if (method !== "GET") return send<T>(method, url, body);
  const answer: Promise<T> = send<T>(method, url, body).then((data) => {
    const last = newest.get(url) as Promise<T> | undefined;
    // When the newer GET fails, this answer is the newest one there is.
    return last === undefined || last === answer ? data : last.catch(() => data);
  });
  newest.set(url, answer);
  return answer;
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
