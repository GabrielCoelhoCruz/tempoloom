// The hours menu of item editors (docs/specs/planning-hours.md HRS-11): the
// built-in and custom sets, "Item-specific hours" for items other than tasks,
// and a preview of the chosen ranges with a link to the hours page.
import "./parts.css";
import { useState } from "preact/hooks";
import type { ItemRange } from "../../shared/item-hours.ts";
import { hhmm } from "../lib/format.ts";
import { onLinkClick } from "../lib/router.ts";

export interface HoursChoice {
  id: string;
  kind: string;
  name: string;
  weekly: Record<string, [number, number][]>;
}

export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
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
  item,
}: {
  sets: HoursChoice[];
  /** The chosen set id; "" means work hours. */
  initial?: string;
  allowItem: boolean;
  /** The item-specific hours the fields start with, when `initial` is ITEM. */
  item?: ItemRange;
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
      {chosen === ITEM && <ItemHoursFields initial={item} />}
    </>
  );
}

/**
 * The days and one time range of item-specific hours. Uncontrolled in a form
 * (itemHoursFrom() reads the fields), or controlled with `value` and `onChange`.
 */
export function ItemHoursFields({
  initial,
  value,
  onChange,
}: {
  /** The range the fields start with; none means 09:00-17:00 on no days. */
  initial?: ItemRange | undefined;
  value?: ItemRange;
  onChange?: (r: ItemRange) => void;
}) {
  const set = (change: Partial<ItemRange>) => value && onChange?.({ ...value, ...change });
  const day = (n: number) =>
    value
      ? {
          checked: value.days.includes(n),
          onChange: (e: { currentTarget: HTMLInputElement }) =>
            set({
              days: e.currentTarget.checked
                ? [...value.days, n].sort((a, b) => a - b)
                : value.days.filter((x) => x !== n),
            }),
        }
      : { name: "itemDays", value: n, defaultChecked: initial?.days.includes(n) ?? false };
  const time = (key: "from" | "to", name: string, start: string) =>
    value
      ? {
          value: value[key],
          onInput: (e: { currentTarget: HTMLInputElement }) =>
            set({ [key]: e.currentTarget.value }),
        }
      : { name, defaultValue: initial?.[key] ?? start };
  return (
    <fieldset class="wide item-hours" data-testid="item-hours">
      <legend>Item-specific hours</legend>
      {DAYS.map((d, i) => (
        <label class="inline" key={d}>
          <input type="checkbox" {...day(i + 1)} />
          {d}
        </label>
      ))}
      <label class="inline">
        From
        <input type="time" step={900} {...time("from", "itemFrom", "09:00")} />
      </label>
      <label class="inline">
        To
        <input type="time" step={900} {...time("to", "itemTo", "17:00")} />
      </label>
    </fieldset>
  );
}
