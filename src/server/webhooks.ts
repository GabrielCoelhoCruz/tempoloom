// Outgoing webhooks for booking links (docs/specs/integrations-webhooks.md).
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { SecretBox } from "./crypto.ts";
import { all, type Db, one, run } from "./db.ts";

export const API_VERSION = "v2026-10-01";
export type WebhookType =
  | "booking_link.meeting.created"
  | "booking_link.meeting.updated"
  | "booking_link.meeting.cancelled";
const OK = new Set([200, 201, 202, 204]);
const TIMEOUT_MS = 10_000;
const MAX_DELAY_MS = 3_600_000;
const SUSPEND_AFTER_MS = 24 * 3_600_000;

export const newSecret = () => randomBytes(32).toString("base64url");

export function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("base64")}`;
}

function privateAddress(ip: string): boolean {
  if (ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80"))
    return true;
  const m = /^(\d+)\.(\d+)\./.exec(ip);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/** Validates an endpoint URL (fields table and rule 13). Returns an error text or null. */
export function urlProblem(raw: string, allowPrivate: boolean): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Not a valid URL";
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopbackName = host === "localhost" || host.endsWith(".localhost");
  // Rule 13: the operator setting allows private receivers, which may use http.
  if (allowPrivate && (loopbackName || (isIP(host) && privateAddress(host))))
    return url.protocol === "https:" || url.protocol === "http:" ? null : "Use https";
  if (url.protocol !== "https:") return "Use https";
  if (loopbackName || isIP(host)) return "Use a public host name";
  return null;
}

export interface CustomData {
  data: Record<string, string>;
  errors: string[];
}

/** Rules 18-20: up to five `data-` parameters, under 512 bytes, prefix removed. */
export function customData(params: [string, string][]): CustomData {
  const named = params.filter(([k]) => k.startsWith("data-") && k.length > 5);
  const data = Object.fromEntries(named.map(([k, v]) => [k.slice(5), v]));
  if (named.length > 5 || Buffer.byteLength(JSON.stringify(data)) >= 512)
    return { data: {}, errors: ["TRUNCATED"] };
  return { data, errors: [] };
}

export interface WebhookDeps {
  db: Db;
  box: SecretBox;
  allowPrivate: boolean;
  retryBaseMs: number;
  now: () => number;
}

/** Queues one event for every active endpoint attached to the link (rule 7). */
export function enqueueBookingEvent(
  deps: WebhookDeps,
  linkId: string,
  type: WebhookType,
  body: Record<string, unknown>,
): void {
  const endpoints = all<{ id: string }>(
    deps.db,
    `SELECT e.id FROM webhook_endpoints e JOIN booking_link_webhooks w ON w.endpoint_id = e.id
     WHERE w.link_id = ? AND e.status = 'active'`,
    linkId,
  );
  const ts = deps.now();
  for (const e of endpoints) {
    run(
      deps.db,
      `INSERT INTO webhook_deliveries (id, endpoint_id, type, event_ts, payload, status, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      randomUUID(),
      e.id,
      type,
      ts,
      JSON.stringify(body),
      ts,
      ts,
    );
  }
}

async function attempt(
  deps: WebhookDeps,
  d: {
    id: string;
    endpoint_id: string;
    type: string;
    event_ts: number;
    payload: string;
    attempts: number;
    created_at: number;
  },
): Promise<void> {
  const ep = one<{ url: string; secret: string; status: string }>(
    deps.db,
    "SELECT url, secret, status FROM webhook_endpoints WHERE id = ?",
    d.endpoint_id,
  );
  if (!ep || ep.status !== "active") return;
  const body = JSON.stringify({
    type: d.type,
    event_ts: new Date(d.event_ts).toISOString(),
    webhook_sent_at: new Date(deps.now()).toISOString(),
    api_version: API_VERSION,
    request_id: d.id,
    webhook_endpoint_id: d.endpoint_id,
    ...(JSON.parse(d.payload) as object),
  });
  let result: string;
  let retryAfterMs: number | null = null;
  try {
    const host = new URL(ep.url).hostname.replace(/^\[|\]$/g, "");
    if (!deps.allowPrivate) {
      const { address } = await lookup(host);
      if (privateAddress(address)) throw new Error("private address");
    }
    const res = await fetch(ep.url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "x-tempoloom-webhook-type": d.type,
        "x-tempoloom-api-version": API_VERSION,
        "x-tempoloom-signature-256": sign(deps.box.open(ep.secret), body),
      },
      body,
    });
    result = `http_${res.status}`;
    if (OK.has(res.status)) {
      run(
        deps.db,
        "UPDATE webhook_deliveries SET status = 'delivered', attempts = attempts + 1, last_result = ?, delivered_at = ? WHERE id = ?",
        result,
        deps.now(),
        d.id,
      );
      return;
    }
    const ra = res.headers.get("retry-after");
    if (ra)
      retryAfterMs = /^\d+$/.test(ra)
        ? Number(ra) * 1000
        : Math.max(0, Date.parse(ra) - deps.now());
  } catch (err) {
    result = err instanceof Error ? err.name : "error";
  }
  const delay = retryAfterMs ?? Math.min(MAX_DELAY_MS, deps.retryBaseMs * 2 ** d.attempts);
  run(
    deps.db,
    "UPDATE webhook_deliveries SET attempts = attempts + 1, last_result = ?, next_attempt_at = ? WHERE id = ?",
    result,
    deps.now() + delay,
    d.id,
  );
  // Rule 15: suspend an endpoint whose deliveries have all failed for over 24 hours.
  const oldest = one<{ t: number | null }>(
    deps.db,
    "SELECT MIN(created_at) AS t FROM webhook_deliveries WHERE endpoint_id = ? AND status = 'pending'",
    d.endpoint_id,
  )?.t;
  const recent = one(
    deps.db,
    "SELECT 1 FROM webhook_deliveries WHERE endpoint_id = ? AND status = 'delivered' AND delivered_at > ?",
    d.endpoint_id,
    deps.now() - SUSPEND_AFTER_MS,
  );
  if (
    oldest !== null &&
    oldest !== undefined &&
    deps.now() - oldest > SUSPEND_AFTER_MS &&
    !recent
  ) {
    run(deps.db, "UPDATE webhook_endpoints SET status = 'suspended' WHERE id = ?", d.endpoint_id);
  }
}

/** Sends due deliveries, oldest first (rule 11). */
export async function deliverDue(deps: WebhookDeps): Promise<void> {
  const due = all<Parameters<typeof attempt>[1]>(
    deps.db,
    `SELECT id, endpoint_id, type, event_ts, payload, attempts, created_at FROM webhook_deliveries
     WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY event_ts LIMIT 50`,
    deps.now(),
  );
  for (const d of due) await attempt(deps, d);
}

export class WebhookWorker {
  readonly #deps: WebhookDeps;
  #timer: NodeJS.Timeout | undefined;
  #busy: Promise<void> | null = null;

  constructor(deps: WebhookDeps) {
    this.#deps = deps;
  }

  /** Delivers now; also runs every second for retries. */
  kick(): void {
    if (this.#busy) return;
    this.#busy = deliverDue(this.#deps)
      .catch((err) => console.error("webhook delivery failed", err))
      .finally(() => {
        this.#busy = null;
      });
  }

  start(): void {
    this.#timer = setInterval(() => this.kick(), 1000);
  }

  async stop(): Promise<void> {
    clearInterval(this.#timer);
    await this.#busy;
  }
}
