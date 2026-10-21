// The guests' hours of a flexible meeting (docs/specs/meetings-flexible.md
// rules 6-7): the availability map and the hours the organizer sets for one
// guest; and the missed periods of a saved meeting
// (meetings-flexible-rescheduling.md rules 16 and 34).
import { useEffect, useState } from "preact/hooks";
import { type ItemRange, itemHoursOf, itemRangeOf, type Weekly } from "../../shared/item-hours.ts";
import { api } from "../lib/api.ts";
import { hhmm } from "../lib/format.ts";

/** The emails of a comma or space list, lowercased. */
export const emails = (text: string) =>
  text
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

export interface Person {
  email: string;
  class: "user" | "none";
  name: string | null;
  timeZone: string | null;
}

/** Whether Tempoloom can see a guest's availability (rule 6). */
export function PersonLine({ p }: { p: Person }) {
  return p.class === "user" ? (
    <span>
      {p.email}: Tempoloom user, {p.timeZone}
    </span>
  ) : (
    <span class="warning">
      {p.email}: Tempoloom cannot see this person's availability or time zone.
    </span>
  );
}

export const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Rules 6-7: hours of next week in the organizer's zone (src/server/meeting-availability.ts). */
export interface AvailabilityData {
  zone: string;
  week: string;
  people: { email: string; zone: string | null; set: boolean }[];
  days: {
    date: string;
    day: number;
    you: [number, number][];
    people: ([number, number][] | null)[];
    overlap: [number, number][];
  }[];
}

export interface Missed {
  availability: AvailabilityData;
  /** MEET-02 rule 34: periods removed for lack of time. */
  skipped: { period: string; reason: string }[];
  /** MEET-02 rule 16: the period after missed ones and its level. */
  boost: { period: string; level: number; missed: number } | null;
}

const rangesText = (ranges: [number, number][]) =>
  ranges.length ? ranges.map(([s, e]) => `${hhmm(s)}–${hhmm(e)}`).join(", ") : "none";

/** Rule 6: for each day, the organizer's hours, each required guest's hours and the overlap. */
export function AvailabilityMap({ map }: { map: AvailabilityData }) {
  return (
    <table class="wide meta" data-testid="availability-map" data-week={map.week}>
      <caption>
        Meeting hours in the week of {map.week}, in {map.zone}
      </caption>
      <thead>
        <tr>
          <th>Day</th>
          <th>You</th>
          {map.people.map((p) => (
            <th key={p.email}>{p.email}</th>
          ))}
          <th>Overlap</th>
        </tr>
      </thead>
      <tbody>
        {map.days.map((d) => (
          <tr key={d.date} data-day={d.day}>
            <th>{DAY_NAMES[d.day - 1]}</th>
            <td data-person="you">{rangesText(d.you)}</td>
            {d.people.map((r, i) => (
              <td key={map.people[i]?.email} data-person={map.people[i]?.email}>
                {r ? rangesText(r) : "unknown"}
              </td>
            ))}
            <td data-person="overlap">{rangesText(d.overlap)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Rule 7: the hours the organizer sets for guests, by lowercased email, and
 * the map of the form's guests, which follows them (rule 6).
 */
export function useGuestHours(people: { email: string }[]) {
  const [overrides, setOverrides] = useState<Record<string, ItemRange>>({});
  const [map, setMap] = useState<AvailabilityData | null>(null);
  const hoursFor = (email: string) => {
    const range = overrides[email.toLowerCase()];
    return range ? itemHoursOf(range) : null;
  };
  useEffect(() => {
    if (people.length === 0) {
      setMap(null);
      return;
    }
    let live = true;
    api<AvailabilityData>("POST", "/api/meetings/availability", {
      attendees: people.map((p) => ({
        email: p.email,
        required: true,
        hoursOverride: hoursFor(p.email),
      })),
    }).then(
      (m) => live && setMap(m),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [people, overrides]);
  return {
    map,
    overrides,
    setOverrides,
    hoursFor,
    /** The saved hours of a meeting's guests, for its edit form. */
    load: (attendees: { email: string; hoursOverride: Weekly | null }[]) =>
      setOverrides(
        Object.fromEntries(
          attendees.flatMap((a) =>
            a.hoursOverride ? [[a.email.toLowerCase(), itemRangeOf(a.hoursOverride)]] : [],
          ),
        ),
      ),
  };
}

const WEEKDAYS_ON = { days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00" };

/** Rule 7: the organizer's hours for one guest, in the guest's time zone. */
export function GuestHours({
  person,
  state,
}: {
  person: { email: string; timeZone: string | null };
  state: ReturnType<typeof useGuestHours>;
}) {
  const key = person.email.toLowerCase();
  const value = state.overrides[key] ?? null;
  const onChange = (v: ItemRange | null) => {
    const { [key]: _, ...rest } = state.overrides;
    state.setOverrides(v ? { ...rest, [key]: v } : rest);
  };
  return (
    <div class="item-hours" data-testid="attendee-hours" data-email={person.email}>
      <label class="inline">
        <input
          type="checkbox"
          checked={value !== null}
          onChange={(e) => onChange(e.currentTarget.checked ? WEEKDAYS_ON : null)}
        />
        Set hours for {person.email}
      </label>
      {value && (
        <>
          {DAY_NAMES.map((n, i) => (
            <label class="inline" key={n}>
              <input
                type="checkbox"
                checked={value.days.includes(i + 1)}
                onChange={(e) =>
                  onChange({
                    ...value,
                    days: e.currentTarget.checked
                      ? [...value.days, i + 1].sort()
                      : value.days.filter((d) => d !== i + 1),
                  })
                }
              />
              {n}
            </label>
          ))}
          <label class="inline">
            From
            <input
              type="time"
              step={900}
              value={value.from}
              onInput={(e) => onChange({ ...value, from: e.currentTarget.value })}
            />
          </label>
          <label class="inline">
            To
            <input
              type="time"
              step={900}
              value={value.to}
              onInput={(e) => onChange({ ...value, to: e.currentTarget.value })}
            />
          </label>
          <span class="meta">in {person.timeZone}</span>
        </>
      )}
    </div>
  );
}

/** The boost, the skipped periods and the availability map of a saved meeting. */
export function MissedPeriods({ m, reason }: { m: Missed; reason: (code: string) => string }) {
  return (
    <>
      {m.boost && (
        <div class="meta warning" data-testid="meeting-boost">
          Priority boost: {m.boost.period} uses P{m.boost.level} after {m.boost.missed} missed
          period{m.boost.missed === 1 ? "" : "s"}
        </div>
      )}
      {m.skipped.length > 0 && (
        <div class="meta">
          Skipped for lack of time:
          <ul data-testid="skipped-periods">
            {m.skipped.map((p) => (
              <li key={p.period}>
                {p.period}: {reason(p.reason)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {m.availability.people.length > 0 && (
        <details class="meta">
          <summary>Availability map</summary>
          <AvailabilityMap map={m.availability} />
        </details>
      )}
    </>
  );
}
