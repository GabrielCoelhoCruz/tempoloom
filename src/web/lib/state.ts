import { signal } from "@preact/signals";
import type { Settings } from "../../server/settings.ts";
import { ApiError, api } from "./api.ts";

export interface Person {
  id: string;
  email: string;
  name: string;
}

export interface Me {
  user: { id: string; email: string; name: string; time_zone: string };
  /** The delegate behind an acting session; `user` is then the owner (delegated access). */
  actor: Person | null;
  /** Owners who gave the signed-in person delegated access. */
  owners: Person[];
  settings: Settings;
  /** viaGrant: 1 when attached through the team's calendar grant (read-only). */
  accounts: {
    id: string;
    provider: string;
    email: string;
    status: string;
    viaGrant: number;
    /** The main email (accounts-login-emails-permissions.md rule 10). */
    is_main: number;
  }[];
}

export const me = signal<Me | null | undefined>(undefined);

export async function loadMe(): Promise<void> {
  try {
    me.value = await api<Me>("GET", "/api/me");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) me.value = null;
    else throw err;
  }
}

export const zone = () =>
  me.value?.user.time_zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Asks the server to plan now; resolves when the calendar holds the plan. */
export async function planNow(): Promise<void> {
  await api("POST", "/api/planner/sync");
}

export const LEVEL_NAMES: Record<number, string> = {
  1: "P1 critical",
  2: "P2 high",
  3: "P3 medium",
  4: "P4 low",
};
