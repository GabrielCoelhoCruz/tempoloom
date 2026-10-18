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

export async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
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
  return data as T;
}
