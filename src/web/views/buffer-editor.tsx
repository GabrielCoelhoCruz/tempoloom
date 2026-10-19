// The buffer automation form with its filter editor (docs/specs/buffers-automation.md
// rules 3, 4, event filter, calendar_scope): conditions, a plain-language
// description, and the live list of upcoming events that match.
import { useEffect, useState } from "preact/hooks";
import type { Category } from "../../scheduler/categories.ts";
import type { BufferFilter, Comparison } from "../../scheduler/model.ts";
import { describeEvents } from "../../shared/event-description.ts";
import { api } from "../lib/api.ts";
import { CATEGORY_LABELS } from "../lib/categories.ts";
import { formatWhen } from "../lib/format.ts";
import { templateFromUrl } from "../lib/library.ts";
import { LEVEL_NAMES, planNow, zone } from "../lib/state.ts";

const FILTER_CATEGORIES: Category[] = [
  "team_meeting",
  "one_on_one",
  "external_meeting",
  "personal",
  "travel",
  "flight",
];
const COUNT_OPS: [Comparison | "", string][] = [
  ["", "any number"],
  [">=", "at least"],
  ["<=", "at most"],
  ["=", "exactly"],
  [">", "more than"],
  ["<", "fewer than"],
];
const LENGTH_OPS: [Comparison | "", string][] = [
  ["", "any length"],
  [">", "longer than"],
  ["<", "shorter than"],
  [">=", "at least"],
  ["<=", "at most"],
  ["=", "exactly"],
];

interface Conditions {
  people: string;
  text: string;
  textFields: "title" | "all";
  countOp: Comparison | "";
  count: string;
  lengthOp: Comparison | "";
  length: string;
  exactTitle: string;
  tags: string;
  categories: Category[];
  travel: boolean;
  flight: boolean;
  run: string;
}

const EMPTY: Conditions = {
  people: "",
  text: "",
  textFields: "title",
  countOp: "",
  count: "",
  lengthOp: "",
  length: "",
  exactTitle: "",
  tags: "",
  categories: [],
  travel: false,
  flight: false,
  run: "",
};

const list = (v: string) =>
  v
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

function filterOf(c: Conditions): BufferFilter {
  const f: BufferFilter = {};
  if (list(c.people).length) f.people = list(c.people);
  if (list(c.text).length)
    f.text = {
      values: list(c.text),
      fields: c.textFields === "all" ? ["title", "description", "location"] : ["title"],
    };
  if (c.countOp && Number(c.count) >= 1) f.participants = { op: c.countOp, value: Number(c.count) };
  if (c.lengthOp && Number(c.length) >= 1) f.length = { op: c.lengthOp, minutes: Number(c.length) };
  if (c.exactTitle.trim()) f.exactTitle = c.exactTitle.trim();
  if (list(c.tags).length) f.tags = list(c.tags);
  if (c.categories.length) f.categories = c.categories;
  if (c.travel) f.travel = true;
  if (c.flight) f.flight = true;
  if (Number(c.run) >= 1) f.runLongerThanMinutes = Number(c.run);
  return f;
}

function conditionsOf(f: BufferFilter): Conditions {
  return {
    people: (f.people ?? []).join(", "),
    text: (f.text?.values ?? []).join(", "),
    textFields: (f.text?.fields.length ?? 1) > 1 ? "all" : "title",
    countOp: f.participants?.op ?? "",
    count: f.participants ? String(f.participants.value) : "",
    lengthOp: f.length?.op ?? "",
    length: f.length ? String(f.length.minutes) : "",
    exactTitle: f.exactTitle ?? "",
    tags: (f.tags ?? []).join(", "),
    categories: f.categories ?? [],
    travel: f.travel ?? false,
    flight: f.flight ?? false,
    run: f.runLongerThanMinutes ? String(f.runLongerThanMinutes) : "",
  };
}

interface Match {
  id: string;
  title: string;
  start: number;
  end: number;
  calendar: string;
}

export function BufferEditor({
  calendars,
  onSaved,
}: {
  calendars: { id: string; name: string }[];
  onSaved: () => unknown;
}) {
  const template = templateFromUrl();
  const preset = template?.kind === "buffer" ? template : null;
  const [title, setTitle] = useState(preset?.name ?? "");
  const [side, setSide] = useState(preset?.preset.side ?? "after");
  const [before, setBefore] = useState(String(preset?.preset.minutesBefore ?? 15));
  const [after, setAfter] = useState(String(preset?.preset.minutesAfter ?? 15));
  const [level, setLevel] = useState(String(preset?.preset.level ?? 3));
  const [busy, setBusy] = useState(preset?.preset.busy ?? true);
  const [scope, setScope] = useState("");
  const [onConflict, setOnConflict] = useState("remove");
  const [c, setC] = useState<Conditions>(
    preset ? conditionsOf(preset.preset.filter as BufferFilter) : EMPTY,
  );
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<{ total: number; events: Match[] } | null>(null);
  const needsPeople = preset?.preset.filter.people !== undefined;
  const filter = filterOf(c);
  const key = JSON.stringify([filter, scope]);

  // Rule 3: the list follows every change of the filter.
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      void api<{ total: number; events: Match[] }>("POST", "/api/buffers/matches", {
        filter,
        calendarScope: scope || null,
      }).then((m) => {
        if (live) setMatches(m);
      });
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key]);

  const set = <K extends keyof Conditions>(k: K, v: Conditions[K]) => setC({ ...c, [k]: v });

  const applyDescription = () => {
    const { filter: parsed, unknown } = describeEvents(description);
    if (unknown) {
      setError(`Not understood: “${unknown}”.`);
      return;
    }
    setError(null);
    setC(conditionsOf(parsed as BufferFilter));
  };

  const save = async (e: Event) => {
    e.preventDefault();
    if (needsPeople && !filter.people?.length) {
      setError("Add at least one person.");
      return;
    }
    setError(null);
    try {
      await api("POST", "/api/buffers", {
        title: title.trim(),
        side,
        minutesBefore: side === "after" ? 0 : Number(before),
        minutesAfter: side === "before" ? 0 : Number(after),
        level: Number(level),
        busy,
        filter,
        onConflict,
        calendarScope: scope || null,
        // The library shows "Added" by the entry an automation came from (automations-library.md rule 4).
        ...(preset ? { templateId: preset.slug } : {}),
      });
      await planNow();
      await onSaved();
    } catch (err) {
      const b = (err as { body?: { issues?: { message: string }[] } }).body;
      setError(b?.issues?.[0]?.message ?? "Could not save the buffer.");
    }
  };

  const z = zone();
  return (
    <form class="form" data-testid="buffer-editor" onSubmit={(e) => void save(e)}>
      <h3 class="wide">Custom buffer</h3>
      <label class="wide">
        Describe the events
        <textarea
          rows={2}
          value={description}
          placeholder="meetings with ceo@example.com longer than 30 minutes"
          onInput={(e) => setDescription(e.currentTarget.value)}
        />
      </label>
      <div class="actions wide">
        <button type="button" onClick={applyDescription}>
          Use description
        </button>
      </div>
      <label class="wide">
        Title
        <input
          required
          maxLength={255}
          value={title}
          onInput={(e) => setTitle(e.currentTarget.value)}
        />
      </label>
      <label>
        Side
        <select
          value={side}
          onChange={(e) => setSide(e.currentTarget.value as "before" | "after" | "both")}
        >
          <option value="before">Before</option>
          <option value="after">After</option>
          <option value="both">Before and after</option>
        </select>
      </label>
      <label>
        Minutes before
        <input
          type="number"
          min={5}
          max={240}
          step={5}
          value={before}
          disabled={side === "after"}
          onInput={(e) => setBefore(e.currentTarget.value)}
        />
      </label>
      <label>
        Minutes after
        <input
          type="number"
          min={5}
          max={240}
          step={5}
          value={after}
          disabled={side === "before"}
          onInput={(e) => setAfter(e.currentTarget.value)}
        />
      </label>
      <label>
        Priority
        <select value={level} onChange={(e) => setLevel(e.currentTarget.value)}>
          {[1, 2, 3, 4].map((l) => (
            <option value={l} key={l}>
              {LEVEL_NAMES[l]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Show as
        <select
          value={busy ? "busy" : "free"}
          onChange={(e) => setBusy(e.currentTarget.value === "busy")}
        >
          <option value="busy">Busy</option>
          <option value="free">Free</option>
        </select>
      </label>
      <label>
        Calendars
        <select value={scope} onChange={(e) => setScope(e.currentTarget.value)}>
          <option value="">All calendars</option>
          {calendars.map((cal) => (
            <option value={cal.id} key={cal.id}>
              {cal.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        When it conflicts
        <select value={onConflict} onChange={(e) => setOnConflict(e.currentTarget.value)}>
          <option value="remove">Remove the buffer</option>
          <option value="keep_as_conflict">Keep and mark the conflict</option>
        </select>
      </label>
      <fieldset class="wide">
        <legend>Which events (all conditions must match)</legend>
        <label>
          With people
          <input
            value={c.people}
            placeholder="ceo@example.com, @board.example"
            onInput={(e) => set("people", e.currentTarget.value)}
          />
        </label>
        <label>
          Text contains
          <input value={c.text} onInput={(e) => set("text", e.currentTarget.value)} />
        </label>
        <label>
          Search in
          <select
            value={c.textFields}
            onChange={(e) => set("textFields", e.currentTarget.value as "title" | "all")}
          >
            <option value="title">Event name</option>
            <option value="all">Name, description and location</option>
          </select>
        </label>
        <label>
          People in the meeting
          <select
            value={c.countOp}
            onChange={(e) => set("countOp", e.currentTarget.value as Comparison | "")}
          >
            {COUNT_OPS.map(([v, l]) => (
              <option value={v} key={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          Number of people
          <input
            type="number"
            min={1}
            value={c.count}
            onInput={(e) => set("count", e.currentTarget.value)}
          />
        </label>
        <label>
          Length is
          <select
            value={c.lengthOp}
            onChange={(e) => set("lengthOp", e.currentTarget.value as Comparison | "")}
          >
            {LENGTH_OPS.map(([v, l]) => (
              <option value={v} key={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          Length (minutes)
          <input
            type="number"
            min={1}
            value={c.length}
            onInput={(e) => set("length", e.currentTarget.value)}
          />
        </label>
        <label>
          Named exactly
          <input value={c.exactTitle} onInput={(e) => set("exactTitle", e.currentTarget.value)} />
        </label>
        <label>
          Tags
          <input
            value={c.tags}
            placeholder="#tl_prep"
            onInput={(e) => set("tags", e.currentTarget.value)}
          />
        </label>
        <label>
          After back-to-back runs longer than (minutes)
          <input
            type="number"
            min={1}
            value={c.run}
            onInput={(e) => set("run", e.currentTarget.value)}
          />
        </label>
        <div class="wide">
          {FILTER_CATEGORIES.map((cat) => (
            <label class="inline" key={cat}>
              <input
                type="checkbox"
                checked={c.categories.includes(cat)}
                onChange={(e) =>
                  set(
                    "categories",
                    e.currentTarget.checked
                      ? [...c.categories, cat]
                      : c.categories.filter((x) => x !== cat),
                  )
                }
              />
              {CATEGORY_LABELS[cat]}
            </label>
          ))}
          <label class="inline">
            <input
              type="checkbox"
              checked={c.travel}
              onChange={(e) => set("travel", e.currentTarget.checked)}
            />
            At an address or tagged #tl_travel
          </label>
          <label class="inline">
            <input
              type="checkbox"
              checked={c.flight}
              onChange={(e) => set("flight", e.currentTarget.checked)}
            />
            Flights
          </label>
        </div>
      </fieldset>
      {error && (
        <p class="error wide" role="alert">
          {error}
        </p>
      )}
      <div class="wide" data-testid="filter-matches">
        <div class="meta">
          {matches === null
            ? "Looking for matching events…"
            : `${matches.total} matching event${matches.total === 1 ? "" : "s"} ahead`}
        </div>
        {matches?.events.map((m) => (
          <div class="row" key={m.id} data-match={m.title}>
            <span class="match-title">{m.title}</span>
            <span class="meta">
              {formatWhen(z, m.start)}
              {m.calendar ? ` · ${m.calendar}` : ""}
            </span>
          </div>
        ))}
      </div>
      <button type="submit" class="primary">
        Add buffer
      </button>
    </form>
  );
}
