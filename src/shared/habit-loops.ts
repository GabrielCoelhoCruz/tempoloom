// Habits rule 18: a rule that closes a loop of habit rules is refused, in the
// habit form and at the API (the habits of a loop cannot all go first).
import type { HabitDependency } from "../scheduler/model.ts";

export interface StoredHabit {
  id: string;
  title: string;
  /** JSON list of HabitDependency, as stored. */
  dependencies: string;
}

/**
 * The refusal when a rule of `habitId` on the habit `targetId` makes a loop:
 * the target already leads back to `habitId` through the stored rules; null
 * when it does not.
 */
export function loopRefusal(
  habits: readonly StoredHabit[],
  habitId: string,
  targetId: string,
): string | null {
  const byId = new Map(habits.map((h) => [h.id, h]));
  const seen = new Set<string>();
  const next = [targetId];
  for (let id = next.pop(); id !== undefined; id = next.pop()) {
    if (id === habitId)
      return `This rule makes a loop: ${byId.get(targetId)?.title} already depends on ${byId.get(habitId)?.title}, directly or through other habits`;
    if (seen.has(id)) continue;
    seen.add(id);
    const deps = JSON.parse(byId.get(id)?.dependencies || "[]") as HabitDependency[];
    for (const d of deps) if (d.kind === "habit") next.push(d.id);
  }
  return null;
}
