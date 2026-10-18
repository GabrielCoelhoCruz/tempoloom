// Tabs and range helpers shared by the stats views: mine, team and organization.
import { addDays, utcToLocal, weekdayOf } from "../../shared/time.ts";
import { duration } from "../lib/format.ts";
import { onLinkClick, path } from "../lib/router.ts";

const TABS = [
  ["/stats", "My stats"],
  ["/stats/team", "Team stats"],
  ["/stats/organization", "Organization"],
] as const;

export function StatsTabs() {
  return (
    <nav class="tabs" aria-label="Stats views" data-testid="stats-tabs">
      {TABS.map(([href, label]) => (
        <a
          key={href}
          href={href}
          onClick={onLinkClick}
          aria-current={path.value === href ? "page" : undefined}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}

export type Range = readonly [string, string];

/** Quick picks in the user's zone; weeks start on Monday. */
export function quickRanges(zone: string): Record<string, Range> {
  const today = utcToLocal(zone, Date.now()).date;
  const monday = addDays(today, 1 - weekdayOf(today));
  return {
    "Last week": [addDays(monday, -7), addDays(monday, -1)],
    "Last 2 weeks": [addDays(monday, -14), addDays(monday, -1)],
    "Last 4 weeks": [addDays(monday, -28), addDays(monday, -1)],
    "Next week": [addDays(monday, 7), addDays(monday, 13)],
  };
}

/** Report controls live in the address, so a reload shows the same report. */
export const query = () => new URLSearchParams(location.search);
export function saveQuery(q: URLSearchParams): void {
  history.replaceState(null, "", `${location.pathname}?${q}`);
}

export const RANGE_ERRORS: Record<string, string> = {
  range_too_early: "The earliest start is 12 weeks ago.",
  range_too_long: "Pick a range of 120 days or less.",
  invalid_range: "The end date must be on or after the start date.",
};

export const hours = (minutes: number) => duration(Math.round(minutes));

export const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

export function RangeControls(props: {
  picks: Record<string, Range>;
  range: Range;
  onRange: (r: Range) => void;
}) {
  const { picks, range, onRange } = props;
  return (
    <>
      {Object.entries(picks).map(([label, r]) => (
        <button
          type="button"
          key={label}
          aria-pressed={range[0] === r[0] && range[1] === r[1]}
          onClick={() => onRange(r)}
        >
          {label}
        </button>
      ))}
      <label class="inline">
        From
        <input
          type="date"
          aria-label="From"
          value={range[0]}
          onChange={(e) => onRange([e.currentTarget.value, range[1]])}
        />
      </label>
      <label class="inline">
        To
        <input
          type="date"
          aria-label="To"
          value={range[1]}
          onChange={(e) => onRange([range[0], e.currentTarget.value])}
        />
      </label>
    </>
  );
}
