// The client address of a request and a bounded rate limiter by address, for
// the public endpoints (OAuth registration, weekly report share pages). Behind
// a reverse proxy, TRUSTED_PROXIES names the proxies whose X-Forwarded-For the
// server reads; any other peer is the client itself.
import { isIP, isIPv4 } from "node:net";
import type { Context } from "hono";

/**
 * A fixed-window counter per key. The map keeps keys in the order their window
 * started, so expired keys leave from the front and the oldest key goes when
 * the map is full: each hit costs O(1) amortized and the size stays bounded.
 */
export function createLimiter(o: { perWindow: number; windowMs: number; maxKeys: number }) {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    /** Counts one hit; false when the key used up its window. */
    hit(key: string, t: number): boolean {
      for (const [k, w] of windows) {
        if (w.start + o.windowMs > t) break;
        windows.delete(k);
      }
      const w = windows.get(key);
      if (w && w.start + o.windowMs > t) {
        if (w.count >= o.perWindow) return false;
        w.count++;
        return true;
      }
      windows.delete(key);
      if (windows.size >= o.maxKeys) {
        const oldest = windows.keys().next().value;
        if (oldest !== undefined) windows.delete(oldest);
      }
      windows.set(key, { start: t, count: 1 });
      return true;
    },
    size: () => windows.size,
  };
}

const plainAddress = (a: string) => {
  const ip = a.trim().replace(/%.*$/, "");
  const v4 = ip.toLowerCase().startsWith("::ffff:") ? ip.slice(7) : "";
  return isIPv4(v4) ? v4 : ip.toLowerCase();
};

/**
 * The client's address: the socket peer, or, when the peer is a trusted proxy,
 * the rightmost address in X-Forwarded-For that is not a trusted proxy. Entries
 * left of it may be forged by the client and are not read.
 */
export function clientAddress(
  peer: string | undefined,
  forwarded: string | undefined,
  trusted: ReadonlySet<string>,
): string {
  const socket = plainAddress(peer ?? "unknown");
  if (!trusted.has(socket) || !forwarded) return socket;
  const hops = forwarded.split(",").map(plainAddress).reverse();
  for (const hop of hops) {
    if (!isIP(hop)) return socket;
    if (!trusted.has(hop)) return hop;
  }
  return socket;
}

/** The limiter's bucket of an address: IPv4 as is, IPv6 by its /64 network. */
export function addressBucket(address: string): string {
  if (isIP(address) !== 6) return address;
  const [head = "", tail] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return `${groups
    .slice(0, 4)
    .map((g) => Number.parseInt(g || "0", 16).toString(16))
    .join(":")}::/64`;
}

/** The trusted proxy addresses (TRUSTED_PROXIES) in the form that clientAddress compares. */
export function trustedSet(proxies: readonly string[]): ReadonlySet<string> {
  return new Set(proxies.map(plainAddress));
}

/** The client address of a Hono request on the Node server (`c.env.incoming`). */
export function requestAddress(c: Context, trusted: ReadonlySet<string>): string {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return clientAddress(
    env?.incoming?.socket?.remoteAddress,
    c.req.header("x-forwarded-for"),
    trusted,
  );
}
