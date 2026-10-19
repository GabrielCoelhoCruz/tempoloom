// The hours menu of item editors (docs/specs/planning-hours.md HRS-11): the
// built-in and custom sets, "Item-specific hours" for items other than tasks,
// and a preview of the chosen ranges with a link to the hours page.
import { useState } from "preact/hooks";
import { hhmm } from "../lib/format.ts";
import { onLinkClick } from "../lib/router.ts";

export interface HoursChoice {
  id: string;
  kind: string;
  name: string;
  weekly: Record<string, [number, number][]>;
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const ITEM = "item";

/** "Tue, Thu 07:00–08:00; Sat 09:00–12:00": days grouped by equal ranges. */
export function describeWeekly(weekly: Record<string, [number, number][]>): string {
  const groups = new Map<string, string[]>();
  DAYS.forEach((d, i) => {
    const ranges = weekly[String(i + 1)] ?? [];
    if (ranges.length === 0) return;
    const key = ranges.map(([s, e]) => `${hhmm(s)}–${hhmm(e)}`).join(", ");
    groups.set(key, [...(groups.get(key) ?? []), d]);
  });
  return [...groups].map(([ranges, days]) => `${days.join(", ")} ${ranges}`).join("; ");
}

/** Item-specific hours from the form: the checked days, each with one range. */
export function itemHoursFrom(f: FormData): Record<string, [number, number][]> {
  const [fh, fm] = String(f.get("itemFrom") || "09:00")
    .split(":")
    .map(Number) as [number, number];
  const [th, tm] = String(f.get("itemTo") || "17:00")
    .split(":")
    .map(Number) as [number, number];
  const range: [number, number] = [fh * 60 + fm, th * 60 + tm || 1440];
  return Object.fromEntries(f.getAll("itemDays").map((d) => [String(d), [range]]));
}

export function HoursField({
  sets,
  initial = "",
  allowItem,
}: {
  sets: HoursChoice[];
  /** The chosen set id; "" means work hours. */
  initial?: string;
  allowItem: boolean;
}) {
  const [chosen, setChosen] = useState(initial);
  const [preview, setPreview] = useState(false);
  const work = sets.find((s) => s.kind === "work");
  const set = chosen === "" ? work : sets.find((s) => s.id === chosen);
  return (
    <>
      <label>
        Hours
        <select name="hoursSetId" value={chosen} onChange={(e) => setChosen(e.currentTarget.value)}>
          <option value="">Work hours</option>
          {sets
            .filter((h) => h.kind !== "work")
            .map((h) => (
              <option value={h.id} key={h.id}>
                {h.name}
              </option>
            ))}
          {allowItem && <option value={ITEM}>Item-specific hours</option>}
        </select>
      </label>
      <span class="hours-info">
        <button type="button" aria-expanded={preview} onClick={() => setPreview(!preview)}>
          ⓘ<span class="sr-only"> Preview hours</span>
        </button>
        {preview && (
          <span class="popover" data-testid="hours-preview">
            {chosen === ITEM ? (
              <span>The days and times below, for this item only.</span>
            ) : (
              DAYS.map((d, i) => {
                const ranges = set?.weekly[String(i + 1)] ?? [];
                return (
                  <span class="hours-line" key={d}>
                    {d}{" "}
                    {ranges.length
                      ? ranges.map(([s, e]) => `${hhmm(s)}–${hhmm(e)}`).join(", ")
                      : "off"}
                  </span>
                );
              })
            )}
            <a href="/settings?section=hours" onClick={onLinkClick}>
              Edit hours
            </a>
          </span>
        )}
      </span>
      {chosen === ITEM && (
        <fieldset class="wide item-hours" data-testid="item-hours">
          <legend>Item-specific hours</legend>
          {DAYS.map((d, i) => (
            <label class="inline" key={d}>
              <input type="checkbox" name="itemDays" value={i + 1} />
              {d}
            </label>
          ))}
          <label class="inline">
            From
            <input name="itemFrom" type="time" step={900} defaultValue="09:00" />
          </label>
          <label class="inline">
            To
            <input name="itemTo" type="time" step={900} defaultValue="17:00" />
          </label>
        </fieldset>
      )}
    </>
  );
}
