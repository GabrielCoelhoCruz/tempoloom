// Team policies (docs/specs/teams-policies.md): what applies to me, agenda
// reminders, and for admins the policies, agenda templates and reports.
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ApiError, api } from "../lib/api.ts";
import { changedFields } from "../lib/changed.ts";
import { dateText, formatWhen } from "../lib/format.ts";
import { zone } from "../lib/state.ts";

type PolicyType = "focus_time" | "buffers" | "meeting_agendas" | "fragmentation";
type Category = "one_on_one" | "team_meeting" | "external_meeting";
type Flexibility = "low" | "medium" | "high";
type Strictness = "remind" | "adjust" | "auto_decline";
interface BufferRule {
  category: Category;
  minutes: number;
}

interface Policy {
  id: string;
  type: PolicyType;
  name: string;
  scope: { attribute: string; value: string }[];
  goal: Record<string, unknown>;
  enabled: boolean;
}

interface MyPolicy extends Policy {
  flexibility: Flexibility | null;
  automations: { key: string; kind: string; minutes: number | null; personalized: boolean }[];
}

interface Reminder {
  id: string;
  title: string;
  category: Category;
  start: number;
  end: number;
  draft: string;
  proposedEnd: number | null;
  proposal: "pending" | "applied" | "kept" | null;
}

interface Mine {
  isAdmin: boolean;
  policies: MyPolicy[];
  reminders: Reminder[];
  declined: { id: string; title: string; start: number }[];
}

interface AdminData {
  policies: Policy[];
  attributes: string[];
  templates: Record<Category, { body: string; custom: boolean }>;
}

interface Report {
  members: number;
  weeks: { start: string; baseline: boolean }[];
  metrics: {
    id: string;
    label: string;
    format: "hours" | "count" | "percent" | "minutes";
    values: Record<string, number | null>;
  }[];
  notes: string[];
  baseline?: {
    groupBy: string;
    days: string[];
    groups: { name: string; values: Record<string, number> }[];
  };
}

const TYPE_LABELS: Record<PolicyType, string> = {
  focus_time: "Focus time",
  buffers: "Buffers",
  meeting_agendas: "Meeting agendas",
  fragmentation: "Calendar fragmentation",
};
const CATEGORY_LABELS: Record<Category, string> = {
  one_on_one: "One-on-one",
  team_meeting: "Team meeting",
  external_meeting: "External meeting",
};
const CATEGORIES = Object.keys(CATEGORY_LABELS) as Category[];
const STRICTNESS: Record<Strictness, string> = {
  remind: "Remind",
  adjust: "Adjust",
  auto_decline: "Auto-decline",
};
const FLEX: Record<Flexibility, string> = { low: "Low", medium: "Medium", high: "High" };

const errorText = (err: unknown) => {
  const body = err instanceof ApiError ? (err.body as { issues?: { message: string }[] }) : null;
  return body?.issues?.[0]?.message ?? (err instanceof Error ? err.message : String(err));
};

function goalText(p: Policy): string {
  const g = p.goal;
  if (p.type === "focus_time") return `Weekly goal ${Number(g.weeklyGoalMinutes) / 60} h`;
  if (p.type === "buffers") {
    const rules = (name: string, list: unknown) =>
      (list as BufferRule[]).map(
        (r) => `${name} ${CATEGORY_LABELS[r.category].toLowerCase()} ${r.minutes} min`,
      );
    return [
      `daily break ${g.minDailyBreakMinutes} min`,
      ...rules("prep before", g.prepBefore),
      ...rules("follow-up after", g.followUpAfter),
      ...rules("recovery after", g.recoveryAfter),
    ].join(", ");
  }
  if (p.type === "meeting_agendas") {
    const types = (g.meetingTypes as Category[]).map((c) => CATEGORY_LABELS[c]).join(", ");
    const lead =
      g.strictness === "auto_decline" ? `, declines ${Number(g.leadMinutes) / 60} h before` : "";
    return `${STRICTNESS[g.strictness as Strictness]} for ${types}${lead}`;
  }
  return `gaps under ${g.minUsableBlockMinutes} min, ${g.targetReductionPercent}% less, flexibility ${String(g.memberFlexibility)}`;
}

const scopeText = (p: Policy) =>
  p.scope.length === 0
    ? "whole team"
    : p.scope.map((s) => `${s.attribute} = ${s.value}`).join(" or ");

// ---------------------------------------------------------------- policy form

interface Draft {
  id: string | null;
  type: PolicyType;
  name: string;
  attribute: string;
  value: string;
  weeklyGoalHours: number;
  dailyBreak: number;
  prep: { category: Category | ""; minutes: number };
  followUp: { category: Category | ""; minutes: number };
  recovery: { category: Category | ""; minutes: number };
  meetingTypes: Category[];
  strictness: Strictness;
  leadHours: number;
  target: number;
  minBlock: number;
  flexibility: Flexibility;
  enabled: boolean;
}

const EMPTY: Draft = {
  id: null,
  type: "focus_time",
  name: "",
  attribute: "",
  value: "",
  weeklyGoalHours: 10,
  dailyBreak: 30,
  prep: { category: "", minutes: 15 },
  followUp: { category: "", minutes: 15 },
  recovery: { category: "", minutes: 15 },
  meetingTypes: [...CATEGORIES],
  strictness: "remind",
  leadHours: 24,
  target: 25,
  minBlock: 60,
  flexibility: "medium",
  enabled: false,
};

function draftOf(p: Policy): Draft {
  const g = p.goal;
  const rule = (list: unknown) => {
    const [r] = (list as BufferRule[] | undefined) ?? [];
    return r
      ? { category: r.category, minutes: r.minutes }
      : { category: "" as const, minutes: 15 };
  };
  return {
    ...EMPTY,
    id: p.id,
    type: p.type,
    name: p.name,
    attribute: p.scope[0]?.attribute ?? "",
    value: p.scope[0]?.value ?? "",
    enabled: p.enabled,
    ...(p.type === "focus_time" ? { weeklyGoalHours: Number(g.weeklyGoalMinutes) / 60 } : {}),
    ...(p.type === "buffers"
      ? {
          dailyBreak: Number(g.minDailyBreakMinutes),
          prep: rule(g.prepBefore),
          followUp: rule(g.followUpAfter),
          recovery: rule(g.recoveryAfter),
        }
      : {}),
    ...(p.type === "meeting_agendas"
      ? {
          meetingTypes: g.meetingTypes as Category[],
          strictness: g.strictness as Strictness,
          leadHours: Number(g.leadMinutes) / 60,
        }
      : {}),
    ...(p.type === "fragmentation"
      ? {
          target: Number(g.targetReductionPercent),
          minBlock: Number(g.minUsableBlockMinutes),
          flexibility: g.memberFlexibility as Flexibility,
        }
      : {}),
  };
}

function goalOf(d: Draft): Record<string, unknown> {
  const rules = (r: Draft["prep"]) =>
    r.category ? [{ category: r.category, minutes: r.minutes }] : [];
  switch (d.type) {
    case "focus_time":
      return { weeklyGoalMinutes: Math.round(d.weeklyGoalHours * 60) };
    case "buffers":
      return {
        minDailyBreakMinutes: d.dailyBreak,
        prepBefore: rules(d.prep),
        followUpAfter: rules(d.followUp),
        recoveryAfter: rules(d.recovery),
      };
    case "meeting_agendas":
      return {
        meetingTypes: d.meetingTypes,
        strictness: d.strictness,
        leadMinutes: Math.round(d.leadHours * 60),
      };
    case "fragmentation":
      return {
        targetReductionPercent: d.target,
        minUsableBlockMinutes: d.minBlock,
        memberFlexibility: d.flexibility,
      };
  }
}

function bodyOf(draft: Draft) {
  const scope =
    draft.attribute.trim() && draft.value.trim()
      ? [{ attribute: draft.attribute.trim(), value: draft.value.trim() }]
      : [];
  return { name: draft.name, scope, goal: goalOf(draft), enabled: draft.enabled };
}

function PolicyForm({
  draft,
  setDraft,
  attributes,
  onSaved,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  attributes: string[];
  onSaved: () => Promise<void>;
}) {
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...draft, [k]: v });
  const num = (e: Event) => Number((e.currentTarget as HTMLInputElement).value);
  // The body of the policy as the form opened: an edit sends only the fields
  // it changed, so a change saved elsewhere stays.
  const opened = useRef<{ id: string | null; body: ReturnType<typeof bodyOf> } | null>(null);
  if (opened.current?.id !== draft.id) opened.current = { id: draft.id, body: bodyOf(draft) };
  const save = async (e: Event) => {
    e.preventDefault();
    setMessage(null);
    const body = bodyOf(draft);
    try {
      if (draft.id)
        await api(
          "PATCH",
          `/api/policies/${draft.id}`,
          opened.current ? changedFields(opened.current.body, body) : body,
        );
      else await api("POST", "/api/policies", { ...body, type: draft.type });
      setDraft(EMPTY);
      await onSaved();
      setMessage({ ok: true, text: "Policy saved" });
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) });
    }
  };
  const bufferRule = (label: string, key: "prep" | "followUp" | "recovery", minutes: string) => (
    <>
      <label>
        {label}
        <select
          value={draft[key].category}
          onChange={(e) =>
            set(key, { ...draft[key], category: e.currentTarget.value as Category | "" })
          }
        >
          <option value="">None</option>
          {CATEGORIES.map((c) => (
            <option value={c} key={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
      </label>
      <label>
        {minutes}
        <input
          type="number"
          min={5}
          max={240}
          step={5}
          value={draft[key].minutes}
          onInput={(e) => set(key, { ...draft[key], minutes: num(e) })}
        />
      </label>
    </>
  );
  return (
    <form class="form" data-testid="policy-form" onSubmit={save}>
      <h3 class="wide">{draft.id ? `Edit ${draft.name}` : "New policy"}</h3>
      <label>
        Type
        <select
          value={draft.type}
          disabled={draft.id !== null}
          onChange={(e) => set("type", e.currentTarget.value as PolicyType)}
        >
          {(Object.keys(TYPE_LABELS) as PolicyType[]).map((t) => (
            <option value={t} key={t}>
              {TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Name
        <input
          required
          maxLength={100}
          value={draft.name}
          onInput={(e) => set("name", e.currentTarget.value)}
        />
      </label>
      <label>
        Scope attribute
        <input
          list="policy-attributes"
          placeholder="Empty: whole team"
          value={draft.attribute}
          onInput={(e) => set("attribute", e.currentTarget.value)}
        />
        <datalist id="policy-attributes">
          {attributes.map((a) => (
            <option value={a} key={a} />
          ))}
        </datalist>
      </label>
      <label>
        Scope value
        <input value={draft.value} onInput={(e) => set("value", e.currentTarget.value)} />
      </label>
      {draft.type === "focus_time" && (
        <label>
          Weekly goal (hours)
          <input
            type="number"
            min={1}
            max={40}
            step={0.5}
            value={draft.weeklyGoalHours}
            onInput={(e) => set("weeklyGoalHours", num(e))}
          />
        </label>
      )}
      {draft.type === "buffers" && (
        <>
          <label>
            Minimum daily break (minutes)
            <input
              type="number"
              min={0}
              max={240}
              step={15}
              value={draft.dailyBreak}
              onInput={(e) => set("dailyBreak", num(e))}
            />
          </label>
          {bufferRule("Prep before", "prep", "Prep minutes")}
          {bufferRule("Follow-up after", "followUp", "Follow-up minutes")}
          {bufferRule("Recovery after", "recovery", "Recovery minutes")}
        </>
      )}
      {draft.type === "meeting_agendas" && (
        <>
          <fieldset class="wide">
            <legend>Meeting types</legend>
            {CATEGORIES.map((c) => (
              <label class="inline" key={c}>
                <input
                  type="checkbox"
                  checked={draft.meetingTypes.includes(c)}
                  onChange={(e) =>
                    set(
                      "meetingTypes",
                      e.currentTarget.checked
                        ? [...draft.meetingTypes, c]
                        : draft.meetingTypes.filter((x) => x !== c),
                    )
                  }
                />
                {CATEGORY_LABELS[c]}
              </label>
            ))}
          </fieldset>
          <label>
            Strictness
            <select
              value={draft.strictness}
              onChange={(e) => set("strictness", e.currentTarget.value as Strictness)}
            >
              {(Object.keys(STRICTNESS) as Strictness[]).map((s) => (
                <option value={s} key={s}>
                  {STRICTNESS[s]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Decline lead time (hours)
            <input
              type="number"
              min={1}
              max={336}
              value={draft.leadHours}
              onInput={(e) => set("leadHours", num(e))}
            />
          </label>
          <p class="meta wide">
            Remind: the organizer gets a reminder with a draft from the meeting type's template.
            Adjust: also a proposal to shorten the meeting, which the organizer applies.
            Auto-decline: also declines invitations without an agenda at the lead time.
          </p>
        </>
      )}
      {draft.type === "fragmentation" && (
        <>
          <label>
            Target reduction (%)
            <input
              type="number"
              min={0}
              max={100}
              value={draft.target}
              onInput={(e) => set("target", num(e))}
            />
          </label>
          <label>
            Minimum usable block (minutes)
            <input
              type="number"
              min={15}
              max={240}
              step={15}
              value={draft.minBlock}
              onInput={(e) => set("minBlock", num(e))}
            />
          </label>
          <label>
            Member flexibility
            <select
              value={draft.flexibility}
              onChange={(e) => set("flexibility", e.currentTarget.value as Flexibility)}
            >
              {(Object.keys(FLEX) as Flexibility[]).map((f) => (
                <option value={f} key={f}>
                  {FLEX[f]}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <label class="inline">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => set("enabled", e.currentTarget.checked)}
        />
        Enabled
      </label>
      <div class="wide">
        <button type="submit" class="primary">
          Save policy
        </button>
        {draft.id && (
          <button type="button" onClick={() => setDraft(EMPTY)}>
            Cancel
          </button>
        )}
        {message &&
          (message.ok ? (
            <span class="status" data-testid="policy-saved">
              {message.text}
            </span>
          ) : (
            <span class="error" role="alert">
              {message.text}
            </span>
          ))}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- reports

const fmt = (v: number | null | undefined, format: Report["metrics"][number]["format"]) =>
  v === null || v === undefined
    ? "–"
    : format === "hours" || format === "count"
      ? v.toFixed(1)
      : String(Math.round(v));

function ReportView({
  policy,
  report,
  groupBy,
  onGroupBy,
}: {
  policy: Policy;
  report: Report;
  groupBy: string;
  onGroupBy: (g: string) => void;
}) {
  const [group, setGroup] = useState(groupBy || "department");
  const b = report.baseline;
  const baselineWeeks = report.weeks.filter((w) => w.baseline).map((w) => w.start);
  return (
    <section data-testid="policy-report">
      <h2>Report: {policy.name}</h2>
      <p class="meta" data-testid="report-members">
        {report.members} {report.members === 1 ? "member" : "members"} in scope
      </p>
      <p class="meta">Values are group averages. The first 4 weeks are the baseline.</p>
      {report.notes.map((n) => (
        <p class="meta" key={n}>
          {n}
        </p>
      ))}
      <table class="report-table">
        <thead>
          <tr>
            <th>Week of</th>
            {report.weeks.map((w) => (
              <th
                key={w.start}
                data-week={w.start}
                class={w.baseline ? "baseline" : undefined}
                title={w.baseline ? "Baseline" : undefined}
              >
                {dateText(w.start)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {report.metrics.map((m) => (
            <tr key={m.id} data-metric={m.id}>
              <th>{m.label}</th>
              {report.weeks.map((w) => (
                <td key={w.start} data-week={w.start}>
                  {fmt(m.values[w.start], m.format)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {policy.type === "fragmentation" && (
        <form
          class="form"
          onSubmit={(e) => {
            e.preventDefault();
            onGroupBy(group.trim());
          }}
        >
          <label>
            Group by
            <input value={group} onInput={(e) => setGroup(e.currentTarget.value)} />
          </label>
          <button type="submit">Show baseline</button>
        </form>
      )}
      {b && (
        <div data-testid="baseline">
          <h3>Baseline: fragmented minutes per day, by {b.groupBy}</h3>
          {b.groups.map((g) => (
            <table class="report-table" data-group={g.name} key={g.name}>
              <caption>{g.name}</caption>
              <tbody>
                {baselineWeeks.map((w) => (
                  <tr key={w}>
                    <th>{w}</th>
                    {b.days
                      .filter((d) => d >= w && d < nextWeek(w))
                      .map((d) => (
                        <td key={d} data-date={d} title={d}>
                          {g.values[d] ?? 0}
                        </td>
                      ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </div>
      )}
    </section>
  );
}

const nextWeek = (d: string) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 7);
  return t.toISOString().slice(0, 10);
};

// ---------------------------------------------------------------- admin

function Templates({ data, reload }: { data: AdminData; reload: () => Promise<void> }) {
  const [texts, setTexts] = useState(
    Object.fromEntries(CATEGORIES.map((c) => [c, data.templates[c].body])),
  );
  const [saved, setSaved] = useState(false);
  return (
    <section data-testid="agenda-templates">
      <h2>Agenda templates</h2>
      <p class="meta">
        Reminders offer the template of the meeting's type as a draft. Tempoloom does not write
        agendas with AI. Empty a template to use the built-in one again.
      </p>
      <form
        class="form"
        onSubmit={async (e) => {
          e.preventDefault();
          setSaved(false);
          await api("PUT", "/api/policies/templates", { templates: texts });
          await reload();
          setSaved(true);
        }}
      >
        {CATEGORIES.map((c) => (
          <label class="wide" key={c}>
            {CATEGORY_LABELS[c]} template
            <textarea
              rows={4}
              value={texts[c]}
              onInput={(e) => setTexts({ ...texts, [c]: e.currentTarget.value })}
            />
          </label>
        ))}
        <div class="wide">
          <button type="submit" class="primary">
            Save templates
          </button>
          {saved && (
            <span class="status" data-testid="templates-saved">
              Templates saved
            </span>
          )}
        </div>
      </form>
    </section>
  );
}

function Admin({ data, reload }: { data: AdminData; reload: () => Promise<void> }) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const params = new URLSearchParams(location.search);
  const [reportId, setReportId] = useState(params.get("report"));
  const [groupBy, setGroupBy] = useState(params.get("groupBy") ?? "");
  const [report, setReport] = useState<Report | null>(null);
  /** Each click on "Report" reads the report again. */
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);

  /** The open report lives in the URL, so it stays open across a reload. */
  const showReport = (id: string | null, group: string) => {
    const q = new URLSearchParams();
    if (id) q.set("report", id);
    if (id && group) q.set("groupBy", group);
    history.replaceState(null, "", `/policies${q.size ? `?${q}` : ""}`);
    setReportId(id);
    setGroupBy(group);
    setVersion((v) => v + 1);
  };

  useEffect(() => {
    setReport(null);
    if (!reportId) return;
    void api<{ report: Report }>(
      "GET",
      `/api/policies/${reportId}/report${groupBy ? `?groupBy=${encodeURIComponent(groupBy)}` : ""}`,
    )
      .then((r) => setReport(r.report))
      .catch(() => showReport(null, ""));
  }, [reportId, groupBy, version]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const reported = data.policies.find((p) => p.id === reportId);
  return (
    <div data-testid="policy-admin">
      <h2>Team policies</h2>
      <p class="meta">
        Only admins manage policies. A policy applies to the whole team or to people with a
        directory attribute; on overlap the narrower scope wins. Members can change the goal that a
        policy gives them.
      </p>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <div class="list">
        {data.policies.map((p) => (
          <div class="row" data-policy={p.name} key={p.id}>
            <div>
              <div>
                {p.name} <span class="badge">{p.enabled ? "on" : "off"}</span>
              </div>
              <div class="meta">
                {TYPE_LABELS[p.type]} · {scopeText(p)} · {goalText(p)}
              </div>
            </div>
            <div class="actions">
              <button type="button" onClick={() => setDraft(draftOf(p))}>
                Edit
              </button>
              <button
                type="button"
                onClick={() =>
                  void act(() => api("PATCH", `/api/policies/${p.id}`, { enabled: !p.enabled }))
                }
              >
                {p.enabled ? "Disable" : "Enable"}
              </button>
              <button type="button" onClick={() => showReport(p.id, groupBy)}>
                Report
              </button>
              <button
                type="button"
                class="danger"
                onClick={() => void act(() => api("DELETE", `/api/policies/${p.id}`))}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
      <PolicyForm draft={draft} setDraft={setDraft} attributes={data.attributes} onSaved={reload} />
      {reported && report && (
        <ReportView
          policy={reported}
          report={report}
          groupBy={groupBy}
          onGroupBy={(g) => showReport(reportId, g)}
        />
      )}
      <Templates data={data} reload={reload} />
    </div>
  );
}

// ---------------------------------------------------------------- members

function MyPolicyRow({ p, reload }: { p: MyPolicy; reload: () => Promise<void> }) {
  const focus = p.automations.find((a) => a.kind === "focus");
  const [goal, setGoal] = useState(focus?.minutes != null ? String(focus.minutes / 60) : "");
  const [flex, setFlex] = useState<Flexibility>(p.flexibility ?? "medium");
  const [saved, setSaved] = useState(false);
  return (
    <div class="row" data-my-policy={p.name}>
      <div>
        <div>{p.name}</div>
        <div class="meta">
          {TYPE_LABELS[p.type]} · {goalText(p)}
          {focus?.personalized ? " · your goal is personalized" : ""}
        </div>
      </div>
      <div class="actions">
        {focus && (
          <form
            class="inline-form"
            onSubmit={async (e) => {
              e.preventDefault();
              await api("PATCH", `/api/policies/${p.id}/mine/focus`, {
                minutes: Math.round(Number(goal) * 60),
              });
              await reload();
            }}
          >
            <label>
              My weekly goal (hours)
              <input
                type="number"
                min={0}
                max={40}
                step={0.5}
                value={goal}
                onInput={(e) => setGoal(e.currentTarget.value)}
              />
            </label>
            <button type="submit">Save goal</button>
          </form>
        )}
        {p.type === "fragmentation" && (
          <form
            class="inline-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setSaved(false);
              await api("PUT", `/api/policies/${p.id}/mine`, { flexibility: flex });
              setSaved(true);
            }}
          >
            <label>
              My flexibility
              <select value={flex} onChange={(e) => setFlex(e.currentTarget.value as Flexibility)}>
                {(Object.keys(FLEX) as Flexibility[]).map((f) => (
                  <option value={f} key={f}>
                    {FLEX[f]}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit">Save flexibility</button>
            {saved && (
              <span class="status" data-testid="my-policy-saved">
                Saved
              </span>
            )}
          </form>
        )}
      </div>
    </div>
  );
}

function ReminderCard({ r, reload }: { r: Reminder; reload: () => Promise<void> }) {
  const [text, setText] = useState(r.draft);
  const [error, setError] = useState<string | null>(null);
  const act = async (path: string, body?: unknown) => {
    setError(null);
    try {
      await api("POST", `/api/policies/reminders/${r.id}/${path}`, body);
      await reload();
    } catch (err) {
      setError(errorText(err));
    }
  };
  const minutes = r.proposedEnd === null ? 0 : Math.round((r.proposedEnd - r.start) / 60_000);
  return (
    <div class="row reminder" data-reminder={r.title}>
      <div>
        <div>
          {r.title} · {formatWhen(zone(), r.start)}
        </div>
        <div class="meta">
          No agenda yet. Draft from the {CATEGORY_LABELS[r.category].toLowerCase()} template. No AI
          draft: edit it before you add it.
        </div>
        <label>
          Draft agenda
          <textarea rows={4} value={text} onInput={(e) => setText(e.currentTarget.value)} />
        </label>
        {r.proposal === "pending" && (
          <div class="meta">
            Proposed: shorten to {minutes} minutes.{" "}
            <button type="button" onClick={() => void act("shorten")}>
              Shorten
            </button>{" "}
            <button type="button" onClick={() => void act("keep")}>
              Keep length
            </button>
          </div>
        )}
        {r.proposal === "applied" && <div class="meta">Shortened to {minutes} minutes.</div>}
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div class="actions">
        <button type="button" class="primary" onClick={() => void act("agenda", { text })}>
          Add agenda to meeting
        </button>
        <button type="button" onClick={() => void act("dismiss")}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

export function PoliciesPage() {
  const [mine, setMine] = useState<Mine | null>(null);
  const [admin, setAdmin] = useState<AdminData | null>(null);
  const load = useCallback(async () => {
    const m = await api<Mine>("GET", "/api/policies/mine");
    setMine(m);
    if (m.isAdmin) setAdmin(await api<AdminData>("GET", "/api/policies"));
  }, []);
  useEffect(() => void load(), [load]);
  if (!mine) return null;
  const agendas =
    mine.policies.some((p) => p.type === "meeting_agendas") ||
    mine.reminders.length > 0 ||
    mine.declined.length > 0;
  return (
    <div class="page" data-testid="policies-page">
      <h1>Policies</h1>
      <section data-testid="my-policies">
        <h2>Policies that apply to you</h2>
        {mine.policies.length === 0 && <p class="meta">No team policy applies to you.</p>}
        <div class="list">
          {mine.policies.map((p) => (
            <MyPolicyRow
              p={p}
              reload={load}
              key={`${p.id}:${p.automations.map((a) => a.minutes).join()}`}
            />
          ))}
        </div>
      </section>
      {agendas && (
        <>
          <section data-testid="agenda-reminders">
            <h2>Meetings you organize without an agenda</h2>
            <div class="list">
              {mine.reminders.map((r) => (
                <ReminderCard r={r} reload={load} key={r.id} />
              ))}
            </div>
          </section>
          <section data-testid="agenda-declines">
            <h2>Declined for no agenda</h2>
            <div class="list">
              {mine.declined.map((d) => (
                <div class="row" data-declined={d.title} key={d.id}>
                  <div>
                    {d.title} · {formatWhen(zone(), d.start)}
                  </div>
                  <div class="meta">Declined: no agenda</div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
      {admin && <Admin data={admin} reload={load} />}
    </div>
  );
}
