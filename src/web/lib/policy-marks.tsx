// Marks on automations that a team policy made (docs/specs/teams-policies.md outputs).
import { signal } from "@preact/signals";
import { api } from "./api.ts";

/** Item id -> name of the team policy that made the automation. */
export const policyMarks = signal<Record<string, string>>({});

export async function loadPolicyMarks(): Promise<void> {
  try {
    policyMarks.value = (
      await api<{ marks: Record<string, string> }>("GET", "/api/policies/mine")
    ).marks;
  } catch {
    policyMarks.value = {};
  }
}

export function PolicyMark({ id }: { id: string }) {
  const name = policyMarks.value[id];
  return name ? <span class="badge">From team policy: {name}</span> : null;
}
