// What the team recommends to a member (teams-settings-templates.md rules 4,
// 5, 9): habit templates on the habits page and in onboarding, and the focus
// time recommendation of a new member in the focus settings.
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import { duration } from "../lib/format.ts";
import { LEVEL_NAMES, planNow } from "../lib/state.ts";

export interface HabitTemplate {
  id: string;
  title: string;
  idealTime: string;
  minutes: number;
  /** ISO weekdays; null: every day of its hours. */
  days: number[] | null;
  level: number;
  hours: "work" | "personal";
}

export const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const templateSummary = (t: HabitTemplate) =>
  [
    duration(t.minutes),
    t.days ? t.days.map((d) => DAY_NAMES[d - 1]).join(", ") : "every day",
    t.idealTime,
    LEVEL_NAMES[t.level],
    t.hours === "personal" ? "personal hours" : "work hours",
  ].join(" · ");

/** Makes the member's own habit from a template; later template changes never touch it. */
async function addFromTemplate(t: HabitTemplate): Promise<void> {
  const { hours } = await api<{ hours: { id: string; kind: string }[] }>("GET", "/api/hours");
  const set = hours.find((h) => h.kind === t.hours);
  await api("POST", "/api/habits", {
    title: t.title,
    idealTime: t.idealTime,
    minMinutes: t.minutes,
    maxMinutes: t.minutes,
    level: t.level,
    frequency: t.days ? { period: "weekly", days: t.days } : { period: "daily" },
    ...(set ? { hoursSetId: set.id } : {}),
  });
  await planNow();
}

/** Templates with an Add button, or "Added" when the member has a habit of that name. */
export function TemplateList({
  templates,
  taken,
  onAdded,
}: {
  templates: HabitTemplate[];
  taken: string[];
  onAdded: () => unknown;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div class="list">
      {templates.map((t) => (
        <div class="row" key={t.id} data-template={t.title}>
          <div>
            <div>{t.title}</div>
            <div class="meta">{templateSummary(t)}</div>
          </div>
          <div class="actions">
            {taken.some((n) => n.toLowerCase() === t.title.toLowerCase()) ? (
              <span class="badge">Added</span>
            ) : (
              <button
                type="button"
                onClick={async () => {
                  setError(null);
                  try {
                    await addFromTemplate(t);
                    await onAdded();
                  } catch (err) {
                    const body = (err as { body?: { issues?: { message: string }[] } }).body;
                    setError(body?.issues?.[0]?.message ?? String(err));
                  }
                }}
              >
                Add
              </button>
            )}
          </div>
        </div>
      ))}
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The top of the habits page: the team's recommended routines (rule 5). */
export function TeamHabitTemplates({
  habits,
  onAdded,
}: {
  habits: string[];
  onAdded: () => unknown;
}) {
  const [templates, setTemplates] = useState<HabitTemplate[]>([]);
  useEffect(() => {
    void api<{ templates: HabitTemplate[] }>("GET", "/api/team/defaults").then((r) =>
      setTemplates(r.templates),
    );
  }, []);
  if (templates.length === 0) return null;
  return (
    <section data-testid="team-templates">
      <h2>Recommended by your team</h2>
      <TemplateList templates={templates} taken={habits} onAdded={onAdded} />
    </section>
  );
}

/**
 * A new member's focus recommendation (rule 9): accept it, change the weekly
 * goal first, or switch it off. Accepting makes an ordinary focus goal
 * (focus-time.md rule 27). It shows until the member acts on it.
 */
export function FocusRecommendation({ onDone }: { onDone: () => unknown }) {
  const [rec, setRec] = useState<{ weeklyGoalHours: number } | null>(null);
  const [goal, setGoal] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api<{ focus: { weeklyGoalHours: number } | null }>("GET", "/api/team/onboarding").then(
      (r) => {
        setRec(r.focus);
        setGoal(String(r.focus?.weeklyGoalHours ?? ""));
      },
    );
  }, []);
  if (!rec) return null;
  const finish = async (state: "accepted" | "off", before?: () => Promise<unknown>) => {
    setError(null);
    try {
      await before?.();
      await api("POST", "/api/team/focus-recommendation", { state });
      setRec(null);
      await onDone();
    } catch (err) {
      const body = (err as { body?: { issues?: { message: string }[] } }).body;
      setError(body?.issues?.[0]?.message ?? String(err));
    }
  };
  return (
    <form
      class="form"
      data-testid="focus-recommendation"
      onSubmit={(e) => {
        e.preventDefault();
        void finish("accepted", () =>
          api("POST", "/api/focus", { weeklyGoalMinutes: Math.round(Number(goal) * 60) }),
        );
      }}
    >
      <p class="wide">
        Your team recommends {rec.weeklyGoalHours} h of focus time per week. Tempoloom places it
        ahead of time in your work hours.
      </p>
      <label>
        Weekly goal (hours)
        <input
          type="number"
          min={0.5}
          max={40}
          step={0.5}
          value={goal}
          onInput={(e) => setGoal(e.currentTarget.value)}
        />
      </label>
      <button type="submit" class="primary">
        Accept
      </button>
      <button type="button" onClick={() => void finish("off")}>
        Turn off
      </button>
      {error && (
        <p class="error wide" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
