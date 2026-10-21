// Item-specific hours (docs/specs/planning-hours.md): an item's own ranges,
// stored as a hidden hours set that no other item may use. Tasks cannot have them.
// A booking link keeps one per person on the link (booking_link_people).
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type Db, one, run } from "./db.ts";

const range = z
  .tuple([z.number().int().min(0).max(1439), z.number().int().min(1).max(1440)])
  .refine(([s, e]) => e > s, "A range must end after it starts");
export const itemHoursSchema = z
  .partialRecord(z.enum(["1", "2", "3", "4", "5", "6", "7"]), z.array(range).max(12))
  .refine((w) => Object.values(w).some((r) => r && r.length > 0), "Choose at least one day");

/** A new private hours set for one item. */
export function createItemHours(db: Db, userId: string, title: string, weekly: object): string {
  const id = randomUUID();
  run(
    db,
    `INSERT INTO hours_sets (id, user_id, kind, name, weekly, created_at, item_specific)
     VALUES (?, ?, 'custom', ?, ?, ?, 1)`,
    id,
    userId,
    `${title} (item-specific hours)`,
    JSON.stringify(weekly),
    Date.now(),
  );
  return id;
}

/** Sets the ranges of an item's private set, or makes one; returns its id. */
export function saveItemHours(
  db: Db,
  userId: string,
  currentSetId: string,
  title: string,
  weekly: object,
): string {
  if (one(db, "SELECT 1 FROM hours_sets WHERE id = ? AND item_specific = 1", currentSetId)) {
    run(db, "UPDATE hours_sets SET weekly = ? WHERE id = ?", JSON.stringify(weekly), currentSetId);
    return currentSetId;
  }
  return createItemHours(db, userId, title, weekly);
}

/** Removes an item's private set once nothing uses it. */
export function dropItemHours(db: Db, setId: string): void {
  const used = ["tasks", "habits", "focus_goals", "meetings", "booking_link_people"].some((t) =>
    one(db, `SELECT 1 FROM ${t} WHERE hours_set_id = ?`, setId),
  );
  if (!used) run(db, "DELETE FROM hours_sets WHERE id = ? AND item_specific = 1", setId);
}
