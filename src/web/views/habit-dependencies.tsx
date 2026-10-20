// Habit dependencies (habits-automation.md rule 18; meetings-flexible.md rule
// 22): order rules of a habit relative to other habits and flexible meetings.
// The habit form edits the rules of one habit; the meeting form adds or
// removes the rules of habits on that meeting. The rules are stored on the habit.
import { useCallback, useEffect, useState } from "preact/hooks";
import type { HabitDependency } from "../../scheduler/model.ts";
import { api } from "../lib/api.ts";
import { planNow } from "../lib/state.ts";

export const RULES: Record<HabitDependency["rule"], string> = {
  before: "Before",
  "not-after": "Not after",
  "not-same-day": "Not on the same day as",
};

interface Named {
  id: string;
  title: string;
}

interface HabitDeps extends Named {
  dependencies: string;
}

/** The user's habits and flexible meetings, as rule targets. */
function useTargets() {
  const [habits, setHabits] = useState<HabitDeps[]>([]);
  const [meetings, setMeetings] = useState<Named[]>([]);
  const load = useCallback(async () => {
    const [h, m] = await Promise.all([
      api<{ habits: HabitDeps[] }>("GET", "/api/habits"),
      api<{ meetings: Named[] }>("GET", "/api/meetings"),
    ]);
    setHabits(h.habits);
    setMeetings(m.meetings);
  }, []);
  useEffect(() => void load(), [load]);
  return { habits, meetings, load };
}

const parse = (raw: string) => JSON.parse(raw || "[]") as HabitDependency[];

/** The rules of one habit, sent with the form as the JSON field `dependencies`. */
export function HabitDependencyFields({ habitId, initial }: { habitId: string; initial: string }) {
  const { habits, meetings } = useTargets();
  const [list, setList] = useState(() => parse(initial));
  const [rule, setRule] = useState<HabitDependency["rule"]>("before");
  const [target, setTarget] = useState("");
  const name = (d: HabitDependency) =>
    (d.kind === "habit" ? habits : meetings).find((x) => x.id === d.id)?.title ?? "(deleted)";
  const options = [
    ...habits
      .filter((h) => h.id !== habitId)
      .map((h) => ({ value: `habit:${h.id}`, label: `Habit: ${h.title}` })),
    // A meeting rule is before or not after (meetings rule 22).
    ...(rule === "not-same-day"
      ? []
      : meetings.map((m) => ({ value: `meeting:${m.id}`, label: `Meeting: ${m.title}` }))),
  ].filter((o) => !list.some((d) => `${d.kind}:${d.id}` === o.value));
  const chosen = options.some((o) => o.value === target) ? target : (options[0]?.value ?? "");
  return (
    <fieldset class="wide" data-testid="habit-dependencies">
      <legend>Dependencies</legend>
      <input type="hidden" name="dependencies" value={JSON.stringify(list)} />
      <ul class="list">
        {list.map((d) => (
          <li class="row" key={`${d.kind}:${d.id}`} data-testid="dependency">
            <span>
              {RULES[d.rule]} {name(d)}
            </span>
            <button type="button" onClick={() => setList(list.filter((x) => x !== d))}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      {list.length === 0 && <p class="meta">No dependencies: the habit goes on any day.</p>}
      <div class="actions">
        <label>
          Rule
          <select
            aria-label="Rule"
            value={rule}
            onChange={(e) => setRule(e.currentTarget.value as HabitDependency["rule"])}
          >
            {Object.entries(RULES).map(([v, l]) => (
              <option value={v} key={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          Habit or meeting
          <select
            aria-label="Habit or meeting"
            value={chosen}
            onChange={(e) => setTarget(e.currentTarget.value)}
          >
            {options.map((o) => (
              <option value={o.value} key={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={!chosen}
          onClick={() => {
            const [kind, id] = chosen.split(":") as [HabitDependency["kind"], string];
            setList([...list, { rule, kind, id }]);
          }}
        >
          Add dependency
        </button>
      </div>
      <p class="meta">
        Before: the habit goes only on days with the other item, and ends before it starts. Not
        after: on those days it ends before the other item starts. The other item is placed first
        and never moves for this rule.
      </p>
    </fieldset>
  );
}

/** Meetings rule 22: the habit rules on one meeting, saved at once on the habits. */
export function MeetingHabitDependencies({ meetingId }: { meetingId: string }) {
  const { habits, load } = useTargets();
  const [habit, setHabit] = useState("");
  const [rule, setRule] = useState<"before" | "not-after">("before");
  const [error, setError] = useState<string | null>(null);
  const on = (h: HabitDeps) =>
    parse(h.dependencies).find((d) => d.kind === "meeting" && d.id === meetingId);
  const save = async (h: HabitDeps, deps: HabitDependency[]) => {
    setError(null);
    try {
      await api("PATCH", `/api/habits/${h.id}`, { dependencies: deps });
      await planNow();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    await load();
  };
  const free = habits.filter((h) => !on(h));
  const chosen = free.find((h) => h.id === habit) ?? free[0];
  return (
    <fieldset class="wide" data-testid="meeting-habit-dependencies">
      <legend>Habit dependencies</legend>
      <ul class="list">
        {habits
          .filter((h) => on(h))
          .map((h) => (
            <li class="row" key={h.id} data-testid="dependency">
              <span>
                {h.title}: {RULES[on(h)?.rule ?? "before"].toLowerCase()} this meeting
              </span>
              <button
                type="button"
                onClick={() =>
                  void save(
                    h,
                    parse(h.dependencies).filter(
                      (d) => !(d.kind === "meeting" && d.id === meetingId),
                    ),
                  )
                }
              >
                Remove
              </button>
            </li>
          ))}
      </ul>
      <div class="actions">
        <label>
          Habit
          <select
            aria-label="Habit"
            value={chosen?.id ?? ""}
            onChange={(e) => setHabit(e.currentTarget.value)}
          >
            {free.map((h) => (
              <option value={h.id} key={h.id}>
                {h.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Rule
          <select
            aria-label="Rule"
            value={rule}
            onChange={(e) => setRule(e.currentTarget.value as "before" | "not-after")}
          >
            <option value="before">Before this meeting</option>
            <option value="not-after">Not after this meeting</option>
          </select>
        </label>
        <button
          type="button"
          disabled={!chosen}
          onClick={() =>
            chosen &&
            void save(chosen, [
              ...parse(chosen.dependencies),
              { rule, kind: "meeting", id: meetingId },
            ])
          }
        >
          Add habit dependency
        </button>
      </div>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
