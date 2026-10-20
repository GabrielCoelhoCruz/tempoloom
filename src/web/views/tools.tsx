// Public tools: meeting cost calculator and pomodoro timer
// (docs/specs/tools-meeting-cost-calculator.md, tools-pomodoro-timer.md).
// Both work without sign-in; the timer keeps its data in this browser only.
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { duration } from "../lib/format.ts";

const OCCURRENCES = {
  every_weekday: 240,
  weekly: 48,
  biweekly: 24,
  monthly: 12,
  quarterly: 4,
  one_time: 1,
} as const;
type Frequency = keyof typeof OCCURRENCES;
const FREQ_LABEL: Record<Frequency, string> = {
  every_weekday: "Every weekday",
  weekly: "Weekly",
  biweekly: "Every two weeks",
  monthly: "Monthly",
  quarterly: "Quarterly",
  one_time: "One time",
};
const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export function MeetingCost() {
  const defaults = {
    salary: "100000",
    attendees: "5",
    minutes: "30",
    frequency: "weekly" as Frequency,
  };
  const [form, setForm] = useState(defaults);
  const [result, setResult] = useState({ perMeeting: 0, annual: 0 });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const calculate = (e: Event) => {
    e.preventDefault();
    const n = {
      salary: Number(form.salary),
      attendees: Number(form.attendees),
      minutes: Number(form.minutes),
    };
    const errs: Record<string, string> = {};
    for (const [k, v] of Object.entries(n))
      if (!Number.isFinite(v) || v <= 0) errs[k] = "Enter a number above 0.";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const perMeeting = n.attendees * (n.salary / 1920) * (n.minutes / 60);
    setResult({ perMeeting, annual: perMeeting * OCCURRENCES[form.frequency] });
  };
  const field = (k: "salary" | "attendees" | "minutes", label: string) => (
    <label>
      {label}
      <input
        inputMode="numeric"
        value={form[k]}
        onInput={(e) => setForm({ ...form, [k]: e.currentTarget.value })}
      />
      {errors[k] && <span class="error">{errors[k]}</span>}
    </label>
  );
  return (
    <div class="public page" data-testid="meeting-cost">
      <h1>Meeting cost calculator</h1>
      <p class="status">Assumes 48 working weeks and 40 hours a week; counts salary only.</p>
      <form class="form" onSubmit={calculate}>
        {field("salary", "Average annual salary (USD)")}
        {field("attendees", "Attendees")}
        {field("minutes", "Length (minutes)")}
        <label>
          How often
          <select
            value={form.frequency}
            onChange={(e) => setForm({ ...form, frequency: e.currentTarget.value as Frequency })}
          >
            {Object.entries(FREQ_LABEL).map(([v, l]) => (
              <option value={v} key={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" class="primary">
          Calculate
        </button>
        <button
          type="button"
          onClick={() => {
            setForm(defaults);
            setResult({ perMeeting: 0, annual: 0 });
            setErrors({});
          }}
        >
          Reset
        </button>
      </form>
      <div class="list">
        <div class="row">
          <span>Cost per meeting</span>
          <strong data-testid="cost-per-meeting">{money(result.perMeeting)}</strong>
        </div>
        <div class="row">
          <span>Annual cost</span>
          <strong data-testid="cost-annual">{money(result.annual)}</strong>
        </div>
      </div>
    </div>
  );
}

type Phase = "work" | "short" | "long";
const PHASE_LABEL: Record<Phase, string> = {
  work: "Work session",
  short: "Short break",
  long: "Long break",
};
interface TimerSettings {
  work: number;
  short: number;
  long: number;
  autoStart: boolean;
  sound: boolean;
  /** The alarm at the end of a phase (settings `alarm_sound`). */
  alarm: Alarm;
  /** Rule 14: an ambient track during work sessions. */
  bgAudio: boolean;
  bgTrack: Track;
}
interface TimerLog {
  sessions: { at: number; minutes: number }[];
  started: number[];
  breaks: { at: number; minutes: number }[];
  tasks: { id: string; text: string; doneAt: number | null }[];
}
const KEY = "tempoloom.pomodoro";
const load = (): { settings: TimerSettings; log: TimerLog } => {
  const fallback = {
    settings: {
      work: 25,
      short: 5,
      long: 15,
      autoStart: false,
      sound: true,
      alarm: "bell" as Alarm,
      bgAudio: false,
      bgTrack: "white" as Track,
    },
    log: { sessions: [], started: [], breaks: [], tasks: [] },
  };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as typeof fallback | null;
    return raw
      ? {
          settings: { ...fallback.settings, ...raw.settings },
          log: { ...fallback.log, ...raw.log },
        }
      : fallback;
  } catch {
    return fallback;
  }
};
const dayStr = (t: number) => new Date(t).toLocaleDateString("sv-SE");

// Alarm sounds made in the browser: each is a list of [hertz, start, length] tones.
type Alarm = "bell" | "chime" | "digital";
const ALARMS: Record<Alarm, { name: string; tones: [number, number, number][] }> = {
  bell: { name: "Bell", tones: [[880, 0, 0.4]] },
  chime: {
    name: "Chime",
    tones: [
      [660, 0, 0.3],
      [990, 0.3, 0.5],
    ],
  },
  digital: {
    name: "Digital",
    tones: [
      [1200, 0, 0.1],
      [1200, 0.2, 0.1],
      [1200, 0.4, 0.1],
    ],
  },
};

function beep(alarm: Alarm): void {
  try {
    const ctx = new AudioContext();
    for (const [hz, at, len] of (ALARMS[alarm] ?? ALARMS.bell).tones) {
      const osc = ctx.createOscillator();
      osc.frequency.value = hz;
      osc.connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + len);
    }
  } catch {}
}

// Rule 14: ambient tracks made in the browser, so the page needs no audio files.
type Track = "white" | "brown";
const TRACKS: Record<Track, string> = { white: "White noise", brown: "Brown noise" };
let ambient: { ctx: AudioContext; source: AudioBufferSourceNode } | undefined;

function playTrack(track: Track): void {
  stopTrack();
  try {
    const ctx = new AudioContext();
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = track === "white" ? white * 0.3 : last * 3;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0.25;
    source.connect(gain).connect(ctx.destination);
    source.start();
    ambient = { ctx, source };
  } catch {}
}

function stopTrack(): void {
  if (!ambient) return;
  ambient.source.stop();
  void ambient.ctx.close();
  ambient = undefined;
}

/** Rule 13: a small timer that stays in view, in its own window. */
function MiniTimer(p: { phase: string; time: string; running: boolean; onToggle: () => void }) {
  return (
    <div style={{ font: "14px system-ui, sans-serif", textAlign: "center", padding: "8px" }}>
      <div data-testid="mini-phase">{p.phase}</div>
      <div data-testid="mini-timer" style={{ fontSize: "32px", fontWeight: 600 }}>
        {p.time}
      </div>
      <button type="button" onClick={p.onToggle}>
        {p.running ? "Pause" : "Start"}
      </button>
    </div>
  );
}

/** Picture-in-picture where the browser offers it (always on top), else a small popup window. */
async function openMiniWindow(): Promise<Window | null> {
  const pip = (
    window as {
      documentPictureInPicture?: {
        requestWindow(o: { width: number; height: number }): Promise<Window>;
      };
    }
  ).documentPictureInPicture;
  if (pip) {
    try {
      return await pip.requestWindow({ width: 240, height: 130 });
    } catch {}
  }
  const win = window.open("", "tempoloom-pomodoro-mini", "popup,width=260,height=150");
  if (win) win.document.title = "Pomodoro timer";
  return win;
}

export function counters(log: TimerLog, now: number) {
  const today = dayStr(now);
  const d = new Date(now);
  const weekStart = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() - ((d.getDay() + 6) % 7),
  ).getTime();
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const days = new Set(log.sessions.map((s) => dayStr(s.at)));
  const dayBack = (k: number) =>
    dayStr(new Date(d.getFullYear(), d.getMonth(), d.getDate() - k).getTime());
  let streak = 0;
  while (days.has(dayBack(streak))) streak++;
  return {
    today: log.sessions.filter((s) => dayStr(s.at) === today).length,
    week: log.sessions.filter((s) => s.at >= weekStart).length,
    month: log.sessions.filter((s) => s.at >= monthStart).length,
    streak,
  };
}

type Grouping = "day" | "week" | "month";
const startOfWeek = (t: number) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime();
};

/** Rule 17: the stats view, from the log of this browser. */
export function timerStats(log: TimerLog, now: number, by: Grouping) {
  const c = counters(log, now);
  const today = dayStr(now);
  const n = new Date(now);
  const since = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 29).getTime();
  const recent = log.sessions.filter((s) => s.at >= since);
  const recentMinutes = recent.reduce((a, s) => a + s.minutes, 0);
  const started = log.started.filter((t) => t >= since).length;
  const breaks = log.breaks.filter((b) => dayStr(b.at) === today);
  const minutesIn = (from: number, to: number) =>
    log.sessions.filter((s) => s.at >= from && s.at < to).reduce((a, s) => a + s.minutes, 0);
  const bars =
    by === "day"
      ? [6, 5, 4, 3, 2, 1, 0].map((k) => {
          const from = new Date(n.getFullYear(), n.getMonth(), n.getDate() - k).getTime();
          const to = new Date(n.getFullYear(), n.getMonth(), n.getDate() - k + 1).getTime();
          const label = new Date(from).toLocaleDateString("en-GB", {
            weekday: "short",
            day: "numeric",
            month: "short",
          });
          return { label, minutes: minutesIn(from, to) };
        })
      : by === "week"
        ? [3, 2, 1, 0].map((k) => {
            const w = new Date(startOfWeek(now));
            const from = new Date(w.getFullYear(), w.getMonth(), w.getDate() - 7 * k).getTime();
            const to = new Date(w.getFullYear(), w.getMonth(), w.getDate() - 7 * k + 7).getTime();
            const day = new Date(from).toLocaleDateString("en-GB", {
              day: "numeric",
              month: "short",
            });
            return { label: `Week of ${day}`, minutes: minutesIn(from, to) };
          })
        : [2, 1, 0].map((k) => {
            const from = new Date(n.getFullYear(), n.getMonth() - k, 1).getTime();
            const to = new Date(n.getFullYear(), n.getMonth() - k + 1, 1).getTime();
            const label = new Date(from).toLocaleDateString("en-GB", { month: "long" });
            return { label, minutes: minutesIn(from, to) };
          });
  return {
    ...c,
    workToday: log.sessions
      .filter((s) => dayStr(s.at) === today)
      .reduce((a, s) => a + s.minutes, 0),
    avgWorkPerDay: Math.round(recentMinutes / 30),
    tasksToday: log.tasks.filter((t) => t.doneAt && dayStr(t.doneAt) === today).length,
    avgSessionsPerDay: (recent.length / 30).toFixed(1),
    avgLength: log.sessions.length
      ? Math.round(log.sessions.reduce((a, s) => a + s.minutes, 0) / log.sessions.length)
      : 0,
    completion: started
      ? `${Math.round((Math.min(recent.length, started) / started) * 100)}%`
      : "–",
    breaksToday: breaks.length,
    breakMinutesToday: breaks.reduce((a, b) => a + b.minutes, 0),
    bars,
  };
}

function TimerStats({ log }: { log: TimerLog }) {
  const [by, setBy] = useState<Grouping>("day");
  const st = timerStats(log, Date.now(), by);
  const max = Math.max(1, ...st.bars.map((b) => b.minutes));
  const rows: [string, string, string | number][] = [
    ["today", "Sessions today", st.today],
    ["week", "Sessions this week", st.week],
    ["month", "Sessions this month", st.month],
    ["work-today", "Work-session time today", duration(st.workToday)],
    [
      "avg-work-day",
      "Average work-session time per day (last 30 days)",
      duration(st.avgWorkPerDay),
    ],
    ["tasks-today", "Tasks checked off today", st.tasksToday],
    ["streak", "Streak (days in a row)", st.streak],
    ["avg-sessions-day", "Average sessions per day (last 30 days)", st.avgSessionsPerDay],
    ["avg-length", "Average work-session length", duration(st.avgLength)],
    ["completion", "Completion rate (last 30 days)", st.completion],
    ["breaks-today", "Breaks today", st.breaksToday],
    ["break-minutes-today", "Break time today", duration(st.breakMinutesToday)],
  ];
  return (
    <div data-testid="timer-stats-view">
      <h2>Stats</h2>
      <div class="list">
        {rows.map(([id, label, value]) => (
          <div class="row" key={id}>
            <span>{label}</span>
            <strong data-testid={`st-${id}`}>{value}</strong>
          </div>
        ))}
      </div>
      <label>
        Chart by
        <select value={by} onChange={(e) => setBy(e.currentTarget.value as Grouping)}>
          <option value="day">Day</option>
          <option value="week">Week</option>
          <option value="month">Month</option>
        </select>
      </label>
      <div class="list">
        {st.bars.map((b) => (
          <div class="row" key={b.label} data-testid="st-bar">
            <span>{b.label}</span> <span>{duration(b.minutes)}</span>
            <span
              aria-hidden="true"
              style={{
                display: "inline-block",
                height: "8px",
                width: `${Math.round((b.minutes / max) * 160)}px`,
                background: "var(--focus)",
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export function Pomodoro() {
  const initial = useRef(load()).current;
  const [settings, setSettings] = useState(initial.settings);
  const [log, setLog] = useState(initial.log);
  const [phase, setPhase] = useState<Phase>("work");
  const [left, setLeft] = useState(initial.settings.work * 60);
  const [running, setRunning] = useState(false);
  const [sinceLong, setSinceLong] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [mini, setMini] = useState<Window | null>(null);
  const endAt = useRef<number | null>(null);

  useEffect(() => localStorage.setItem(KEY, JSON.stringify({ settings, log })), [settings, log]);
  const length = (p: Phase) => settings[p] * 60;

  // The timer reads live values through refs: the interval may fire before the
  // next render, so render-time state can be stale.
  const live = useRef({ phase, sinceLong, settings });
  live.current.settings = settings;
  const finish = () => {
    const cur = live.current;
    const len = (p: Phase) => cur.settings[p] * 60;
    if (cur.settings.sound) beep(cur.settings.alarm);
    let next: Phase;
    if (cur.phase === "work") {
      cur.sinceLong += 1;
      const minutes = cur.settings.work;
      setLog((l) => ({ ...l, sessions: [...l.sessions, { at: Date.now(), minutes }] }));
      next = cur.sinceLong >= 4 ? "long" : "short";
    } else {
      const minutes = cur.settings[cur.phase];
      setLog((l) => ({ ...l, breaks: [...l.breaks, { at: Date.now(), minutes }] }));
      if (cur.phase === "long") cur.sinceLong = 0;
      next = "work";
    }
    cur.phase = next;
    setSinceLong(cur.sinceLong);
    setPhase(next);
    setLeft(len(next));
    if (cur.settings.autoStart) {
      endAt.current = Date.now() + len(next) * 1000;
      setRunning(true);
      if (next === "work") setLog((l) => ({ ...l, started: [...l.started, Date.now()] }));
    } else {
      endAt.current = null;
      setRunning(false);
    }
  };

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      // Paused or reset: this interval may fire once more before its cleanup runs.
      if (endAt.current === null) return;
      const rest = Math.max(0, Math.round((endAt.current - Date.now()) / 1000));
      setLeft(rest);
      if (rest === 0) finish();
    }, 250);
    return () => clearInterval(t);
  });

  const mm = String(Math.floor(left / 60)).padStart(2, "0");
  const ss = String(left % 60).padStart(2, "0");
  const toggle = () => {
    if (running) {
      setRunning(false);
      endAt.current = null;
    } else {
      endAt.current = Date.now() + left * 1000;
      setRunning(true);
      if (phase === "work" && left === length("work"))
        setLog((l) => ({ ...l, started: [...l.started, Date.now()] }));
    }
  };
  const background = running && phase === "work" && settings.bgAudio;
  useEffect(() => {
    if (background) playTrack(settings.bgTrack);
    else stopTrack();
  }, [background, settings.bgTrack]);
  useEffect(() => stopTrack, []);
  useEffect(() => {
    if (!mini) return;
    if (mini.closed) return setMini(null);
    render(
      <MiniTimer
        phase={PHASE_LABEL[phase]}
        time={`${mm}:${ss}`}
        running={running}
        onToggle={toggle}
      />,
      mini.document.body,
    );
  });
  useEffect(() => {
    if (!mini) return;
    const gone = () => setMini(null);
    mini.addEventListener("pagehide", gone);
    return () => mini.removeEventListener("pagehide", gone);
  }, [mini]);
  useEffect(() => {
    document.title = running ? `${mm}:${ss} · ${PHASE_LABEL[phase]}` : "Pomodoro timer · Tempoloom";
  }, [running, mm, ss, phase]);

  const select = (p: Phase) => {
    live.current.phase = p;
    setPhase(p);
    setLeft(length(p));
    setRunning(false);
    endAt.current = null;
  };
  const c = counters(log, Date.now());
  const todaySessions = log.sessions.filter((s) => dayStr(s.at) === dayStr(Date.now()));
  return (
    <div class="public page" data-testid="pomodoro">
      <div class="toolbar" style={{ border: 0, padding: 0 }}>
        <span class="title">Pomodoro timer</span>
        <span data-testid="count-today">Today {c.today}</span>
        <span data-testid="count-week">Week {c.week}</span>
        <span data-testid="count-month">Month {c.month}</span>
        <span data-testid="count-streak">Streak {c.streak}</span>
        <button type="button" onClick={() => setShowStats(!showStats)}>
          Stats
        </button>
        <button type="button" onClick={() => setShowSettings(!showSettings)}>
          Settings
        </button>
      </div>
      <div class="actions" role="tablist">
        {(Object.keys(PHASE_LABEL) as Phase[]).map((p) => (
          <button
            type="button"
            role="tab"
            key={p}
            aria-selected={p === phase}
            onClick={() => select(p)}
          >
            {PHASE_LABEL[p]}
          </button>
        ))}
      </div>
      <div class="timer" data-testid="timer">
        {mm} {ss}
      </div>
      <progress max={length(phase)} value={length(phase) - left} />
      <p class="status" data-testid="to-long">
        Sessions to long break {sinceLong}/4
      </p>
      <div class="actions">
        <button type="button" class="primary" onClick={toggle}>
          {running ? "Pause" : "Start"}
        </button>
        <button type="button" onClick={() => select(phase)}>
          Reset
        </button>
        <button
          type="button"
          onClick={() => {
            if (mini && !mini.closed) mini.focus();
            else void openMiniWindow().then(setMini);
          }}
        >
          Mini window
        </button>
      </div>
      {background && (
        <p class="status" data-testid="bg-audio">
          Playing: {TRACKS[settings.bgTrack]}
        </p>
      )}
      {showSettings && (
        <div class="form" data-testid="timer-settings">
          {(["work", "short", "long"] as const).map((k) => (
            <label key={k}>
              {PHASE_LABEL[k]} (minutes)
              <input
                type="number"
                min={1}
                max={180}
                value={settings[k]}
                // onInput: a value typed and not yet committed must survive another
                // setting's change, which renders this controlled field again.
                onInput={(e) => {
                  const v = Math.round(Number(e.currentTarget.value));
                  if (!(v >= 1)) return;
                  setSettings((cur) => ({ ...cur, [k]: v }));
                  if (k === phase && !running) setLeft(v * 60);
                }}
              />
            </label>
          ))}
          <label class="inline">
            <input
              type="checkbox"
              checked={settings.autoStart}
              onChange={(e) => setSettings({ ...settings, autoStart: e.currentTarget.checked })}
            />
            Start the next phase on its own
          </label>
          <label class="inline">
            <input
              type="checkbox"
              checked={settings.sound}
              onChange={(e) => setSettings({ ...settings, sound: e.currentTarget.checked })}
            />
            Play a sound at the end of a phase
          </label>
          <label>
            Alarm sound
            <select
              value={settings.alarm}
              onChange={(e) => {
                const alarm = e.currentTarget.value as Alarm;
                setSettings({ ...settings, alarm });
              }}
            >
              {(Object.keys(ALARMS) as Alarm[]).map((a) => (
                <option value={a} key={a}>
                  {ALARMS[a].name}
                </option>
              ))}
            </select>
          </label>
          <label class="inline">
            <input
              type="checkbox"
              checked={settings.bgAudio}
              onChange={(e) => setSettings({ ...settings, bgAudio: e.currentTarget.checked })}
            />
            Background audio in work sessions
          </label>
          <label>
            Track
            <select
              value={settings.bgTrack}
              onChange={(e) =>
                setSettings({ ...settings, bgTrack: e.currentTarget.value as Track })
              }
            >
              {(Object.keys(TRACKS) as Track[]).map((t) => (
                <option value={t} key={t}>
                  {TRACKS[t]}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <h2>Tasks</h2>
      <form
        class="actions"
        onSubmit={(e) => {
          e.preventDefault();
          const input = (e.currentTarget as HTMLFormElement).elements.namedItem(
            "task",
          ) as HTMLInputElement;
          if (!input.value.trim()) return;
          setLog((l) => ({
            ...l,
            tasks: [
              ...l.tasks,
              { id: crypto.randomUUID(), text: input.value.trim(), doneAt: null },
            ],
          }));
          input.value = "";
        }}
      >
        <input name="task" aria-label="New task" placeholder="What are you working on?" />
        <button type="submit">Add task</button>
      </form>
      <div class="list" data-testid="timer-tasks">
        {log.tasks.map((t) => (
          <label class="row inline" key={t.id}>
            <span style={{ textDecoration: t.doneAt ? "line-through" : "none" }}>{t.text}</span>
            <input
              type="checkbox"
              checked={t.doneAt !== null}
              onChange={(e) => {
                const done = e.currentTarget.checked;
                setLog((l) => ({
                  ...l,
                  tasks: l.tasks.map((x) =>
                    x.id === t.id ? { ...x, doneAt: done ? Date.now() : null } : x,
                  ),
                }));
              }}
            />
          </label>
        ))}
      </div>
      {showStats && <TimerStats log={log} />}
      <h2>Today</h2>
      <p class="status" data-testid="timer-stats">
        {todaySessions.length} sessions, {todaySessions.reduce((a, s) => a + s.minutes, 0)} minutes
        of work,{" "}
        {log.tasks.filter((t) => t.doneAt && dayStr(t.doneAt) === dayStr(Date.now())).length} tasks
        done, {log.breaks.filter((b) => dayStr(b.at) === dayStr(Date.now())).length} breaks
      </p>
    </div>
  );
}
