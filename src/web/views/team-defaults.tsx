// Team page: defaults for new members (admins) and the onboarding step of a
// new member (docs/specs/teams-settings-templates.md rules 3-11).
import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import { onLinkClick } from "../lib/router.ts";
import { LEVEL_NAMES } from "../lib/state.ts";
import { HoursEditor } from "./settings.tsx";
import { errorText } from "./team.tsx";
import {
  DAY_NAMES,
  type HabitTemplate,
  TemplateList,
  templateSummary,
} from "./team-recommendations.tsx";

type Weekly = Record<string, [number, number][]>;

interface Defaults {
  canManage: boolean;
  templates: HabitTemplate[];
  workHours: Weekly | null;
  meetingHours: Weekly | null;
  focus: { mode: "proactive"; weeklyGoalHours: number } | null;
}

const NINE_TO_FIVE: Weekly = Object.fromEntries(
  ["1", "2", "3", "4", "5"].map((d) => [d, [[540, 1020]]]),
);

function TemplateForm({
  template,
  onSave,
  onCancel,
}: {
  template: HabitTemplate | null;
  onSave: (t: Omit<HabitTemplate, "id">) => void;
  onCancel: () => void;
}) {
  return (
    <form
      class="form"
      data-testid="template-form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget as HTMLFormElement);
        const days = f.getAll("days").map(Number);
        onSave({
          title: String(f.get("title") ?? "").trim(),
          idealTime: String(f.get("idealTime")),
          minutes: Number(f.get("minutes")),
          level: Number(f.get("level")),
          hours: f.get("hours") === "personal" ? "personal" : "work",
          days: days.length ? days : null,
        });
      }}
    >
      <label class="wide">
        Title
        <input name="title" required maxLength={255} defaultValue={template?.title ?? ""} />
      </label>
      <label>
        Ideal time
        <input
          name="idealTime"
          type="time"
          step={900}
          defaultValue={template?.idealTime ?? "09:00"}
        />
      </label>
      <label>
        Duration (minutes)
        <input
          name="minutes"
          type="number"
          min={15}
          max={720}
          step={15}
          defaultValue={String(template?.minutes ?? 30)}
        />
      </label>
      <label>
        Priority
        <select name="level">
          {[1, 2, 3, 4].map((l) => (
            <option value={l} key={l} selected={l === (template?.level ?? 3)}>
              {LEVEL_NAMES[l]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Hours
        <select name="hours">
          <option value="work" selected={template?.hours !== "personal"}>
            Work hours
          </option>
          <option value="personal" selected={template?.hours === "personal"}>
            Personal hours
          </option>
        </select>
      </label>
      <fieldset class="wide days">
        <legend>Days (none selected: every day of its hours)</legend>
        {DAY_NAMES.map((n, i) => (
          <label key={n} class="inline">
            <input
              type="checkbox"
              name="days"
              value={i + 1}
              defaultChecked={template?.days?.includes(i + 1) ?? false}
            />
            {n}
          </label>
        ))}
      </fieldset>
      <button type="submit" class="primary">
        {template ? "Save template" : "Add template"}
      </button>
      {template && (
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      )}
    </form>
  );
}

function DefaultHours({
  kind,
  weekly,
  onSave,
}: {
  kind: "work" | "meeting";
  weekly: Weekly | null;
  onSave: (w: Weekly | null) => Promise<void>;
}) {
  const [open, setOpen] = useState(weekly !== null);
  const label = `${kind} hours`;
  if (!open)
    return (
      <div class="row">
        <span class="meta">No default {label}: new members keep Tempoloom's standard hours.</span>
        <button type="button" onClick={() => setOpen(true)}>
          Set default {label}
        </button>
      </div>
    );
  return (
    <div>
      <HoursEditor
        set={{
          id: `team-${kind}`,
          kind: `team-${kind}`,
          name: `Default ${label}`,
          weekly: weekly ?? NINE_TO_FIVE,
        }}
        onSave={(w) => onSave(w)}
      />
      <button
        type="button"
        onClick={async () => {
          await onSave(null);
          setOpen(false);
        }}
      >
        Clear default {label}
      </button>
    </div>
  );
}

/** Admins: habit templates, default hours and the focus time template. */
export function TeamDefaults() {
  const [d, setD] = useState<Defaults | null>(null);
  const [editing, setEditing] = useState<HabitTemplate | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => setD(await api<Defaults>("GET", "/api/team/defaults")), []);
  useEffect(() => void load(), [load]);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setMessage(null);
    try {
      await fn();
      await load();
      setMessage(done);
    } catch (err) {
      setMessage(errorText(err));
    }
  };
  if (!d) return null;
  return (
    <section data-testid="team-defaults">
      <h2>Defaults for new members</h2>
      <p class="meta">
        Defaults apply only to people who join after you save them. Members who are already in the
        team keep their settings.
      </p>

      <h3>Habit templates</h3>
      <p class="meta">
        Every member sees these at the top of the habits page; new members also see them when they
        join.
      </p>
      <div class="list">
        {d.templates.map((t) => (
          <div class="row" key={t.id} data-template={t.title}>
            <div>
              <div>{t.title}</div>
              <div class="meta">{templateSummary(t)}</div>
            </div>
            <div class="actions">
              <button type="button" onClick={() => setEditing(t)}>
                Edit
              </button>
              <button
                type="button"
                class="danger"
                onClick={() =>
                  void act(
                    () => api("DELETE", `/api/team/habit-templates/${t.id}`),
                    "Template deleted.",
                  )
                }
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
      <TemplateForm
        key={editing?.id ?? `new-${d.templates.length}`}
        template={editing}
        onCancel={() => setEditing(null)}
        onSave={(t) =>
          void act(async () => {
            if (editing) await api("PUT", `/api/team/habit-templates/${editing.id}`, t);
            else await api("POST", "/api/team/habit-templates", t);
            setEditing(null);
          }, "Template saved.")
        }
      />

      <h3>Default hours</h3>
      <DefaultHours
        kind="work"
        weekly={d.workHours}
        onSave={(w) =>
          act(
            () => api("PATCH", "/api/team/defaults", { workHours: w }),
            "Default work hours saved.",
          )
        }
      />
      <DefaultHours
        kind="meeting"
        weekly={d.meetingHours}
        onSave={(w) =>
          act(
            () => api("PATCH", "/api/team/defaults", { meetingHours: w }),
            "Default meeting hours saved.",
          )
        }
      />

      <h3>Focus time template</h3>
      <form
        class="form"
        data-testid="focus-template"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget as HTMLFormElement);
          void act(
            () =>
              api("PATCH", "/api/team/defaults", {
                focus: { mode: "proactive", weeklyGoalHours: Number(f.get("goal")) },
              }),
            "Focus template saved.",
          );
        }}
      >
        <label>
          Mode
          <select name="mode">
            <option value="proactive">Proactive: place focus time ahead</option>
          </select>
        </label>
        <label>
          Weekly goal (hours)
          <input
            name="goal"
            type="number"
            min={0.5}
            max={40}
            step={0.5}
            defaultValue={String(d.focus?.weeklyGoalHours ?? 10)}
          />
        </label>
        <button type="submit" class="primary">
          Save focus template
        </button>
        {d.focus && (
          <button
            type="button"
            onClick={() =>
              void act(
                () => api("PATCH", "/api/team/defaults", { focus: null }),
                "Focus template removed.",
              )
            }
          >
            Remove focus template
          </button>
        )}
        <p class="meta wide">
          New members see it as a recommendation in their focus settings. Tempoloom has no reactive
          mode.
        </p>
      </form>
      {message && (
        <p class="status" data-testid="defaults-message">
          {message}
        </p>
      )}
    </section>
  );
}

/** A new member's first visit: the team's habit templates and focus recommendation (rule 4). */
export function Onboarding() {
  const [o, setO] = useState<{
    team: string;
    welcome: boolean;
    templates: HabitTemplate[];
    focus: { weeklyGoalHours: number } | null;
  } | null>(null);
  const [habits, setHabits] = useState<string[]>([]);
  const load = useCallback(async () => {
    const [a, h] = await Promise.all([
      api<NonNullable<typeof o>>("GET", "/api/team/onboarding"),
      api<{ habits: { title: string }[] }>("GET", "/api/habits"),
    ]);
    setO(a);
    setHabits(h.habits.map((x) => x.title));
  }, []);
  useEffect(() => void load(), [load]);
  if (!o?.welcome) return null;
  return (
    <section data-testid="onboarding">
      <h2>Welcome to {o.team}</h2>
      {o.templates.length > 0 && (
        <>
          <p>
            Your team recommends these habits. Add the ones you want; you can change them later.
          </p>
          <TemplateList templates={o.templates} taken={habits} onAdded={load} />
        </>
      )}
      {o.focus && (
        <p>
          Your team recommends {o.focus.weeklyGoalHours} h of focus time per week.{" "}
          <a href="/settings" onClick={onLinkClick}>
            Set it up in Settings
          </a>
          .
        </p>
      )}
      <button
        type="button"
        class="primary"
        onClick={async () => {
          await api("POST", "/api/team/onboarding/done");
          setO(null);
        }}
      >
        Done
      </button>
    </section>
  );
}
