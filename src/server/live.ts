// Live updates (accounts-delegated-access.md rule 9): every open page of an
// account holds a server-sent event stream; a change to the account sends a
// signal to each stream, and the page reads its view again. Each signal carries
// the account's change mark; a page compares the mark it last saw with the one
// its stream starts with, so it reads again only after a change it missed.
import { randomUUID } from "node:crypto";

export interface LiveHub {
  /** Registers a page of `userId`; returns the function that removes it. */
  subscribe(userId: string, client: string, send: () => void): () => void;
  /** Signals every page of the account except the one that made the change. */
  notify(userId: string, exceptClient?: string): void;
  /** The account's change mark: it differs after each change and after a server restart. */
  mark(userId: string): string;
}

export function createLiveHub(): LiveHub {
  const pages = new Map<string, Set<{ client: string; send: () => void }>>();
  const counts = new Map<string, number>();
  const epoch = randomUUID().slice(0, 8);
  return {
    subscribe(userId, client, send) {
      const entry = { client, send };
      const set = pages.get(userId) ?? new Set();
      pages.set(userId, set);
      set.add(entry);
      return () => {
        set.delete(entry);
        if (set.size === 0) pages.delete(userId);
      };
    },
    notify(userId, exceptClient) {
      counts.set(userId, (counts.get(userId) ?? 0) + 1);
      for (const p of pages.get(userId) ?? []) if (p.client !== exceptClient) p.send();
    },
    mark: (userId) => `${epoch}.${counts.get(userId) ?? 0}`,
  };
}
