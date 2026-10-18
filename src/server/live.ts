// Live updates (accounts-delegated-access.md rule 9): every open page of an
// account holds a server-sent event stream; a change to the account sends a
// signal to each stream, and the page reads its view again.
export interface LiveHub {
  /** Registers a page of `userId`; returns the function that removes it. */
  subscribe(userId: string, client: string, send: () => void): () => void;
  /** Signals every page of the account except the one that made the change. */
  notify(userId: string, exceptClient?: string): void;
}

export function createLiveHub(): LiveHub {
  const pages = new Map<string, Set<{ client: string; send: () => void }>>();
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
      for (const p of pages.get(userId) ?? []) if (p.client !== exceptClient) p.send();
    },
  };
}
