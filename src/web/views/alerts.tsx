// In-app alerts at event start (docs/specs/planning-notifications.md NTF-1 to
// NTF-3): the tab title flashes the event name, and a short chime plays when
// the user turned it on. Only while a Tempoloom page is open.
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import { useLive } from "../lib/live.ts";
import { me } from "../lib/state.ts";

const TAB = Math.random().toString(36).slice(2);
const LAST_FOCUSED = "tempoloom.lastFocusedTab";

/** Edge case 1: with several tabs, the one focused last plays the chime. */
function chimeTab(): boolean {
  const last = localStorage.getItem(LAST_FOCUSED);
  return last === null || last === TAB;
}

/** Starts that alerted in this tab, kept over reloads so a reload does not alert again. */
const FIRED = "tempoloom.alerted";
const fired = {
  has: (key: string) =>
    (JSON.parse(sessionStorage.getItem(FIRED) ?? "[]") as string[]).includes(key),
  add(key: string) {
    const hourAgo = Date.now() - 3_600_000;
    const keep = (JSON.parse(sessionStorage.getItem(FIRED) ?? "[]") as string[]).filter(
      (k) => Number(k.split(":")[0]) > hourAgo,
    );
    sessionStorage.setItem(FIRED, JSON.stringify([...keep, key]));
  },
};
let audio: AudioContext | undefined;
/** Two short notes; false when the browser does not allow sound yet. */
async function chime(): Promise<boolean> {
  audio ??= new AudioContext();
  if (audio.state !== "running") await audio.resume().catch(() => {});
  if (audio.state !== "running") return false;
  const t = audio.currentTime;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  gain.gain.value = 0.15;
  osc.frequency.setValueAtTime(660, t);
  osc.frequency.setValueAtTime(880, t + 0.18);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + 0.35);
  return true;
}

function flash(title: string) {
  const original = document.title.startsWith("▶ ") ? "Tempoloom" : document.title;
  let on = true;
  document.title = `▶ ${title}`;
  const t = setInterval(() => {
    on = !on;
    document.title = on ? `▶ ${title}` : original;
  }, 1000);
  setTimeout(() => {
    clearInterval(t);
    document.title = original;
  }, 30_000);
}

export function Alerts() {
  const [blocked, setBlocked] = useState(false);
  const timers = useRef<number[]>([]);
  const reschedule = useRef<() => void>(() => {});
  // A new or moved event reaches the page as a live change: read the starts again.
  useLive(() => reschedule.current());
  const settings = me.value?.settings;
  const tabAlert = settings?.tabAlert ?? true;
  const startChime = settings?.startChime ?? false;
  useEffect(() => {
    const focus = () => localStorage.setItem(LAST_FOCUSED, TAB);
    addEventListener("focus", focus);
    return () => removeEventListener("focus", focus);
  }, []);
  useEffect(() => {
    if (!tabAlert && !startChime) return;
    let stop = false;
    const schedule = async () => {
      const { starts } = await api<{ starts: { title: string; start: number }[] }>(
        "GET",
        "/api/now",
      );
      if (stop) return;
      for (const t of timers.current) clearTimeout(t);
      // Only starts that are coming, or began in the last minute, alert.
      timers.current = starts
        .filter((s) => s.start > Date.now() - 60_000)
        .map((s) =>
          window.setTimeout(
            () => {
              // Each start alerts once, whatever reads of the schedule came before.
              const key = `${s.start}:${s.title}`;
              if (fired.has(key)) return;
              fired.add(key);
              if (tabAlert) flash(s.title);
              if (startChime && chimeTab()) void chime().then((ok) => setBlocked(!ok));
            },
            Math.max(0, s.start - Date.now()),
          ),
        );
    };
    void schedule();
    reschedule.current = () => void schedule();
    const poll = setInterval(() => void schedule(), 5 * 60_000);
    return () => {
      stop = true;
      reschedule.current = () => {};
      clearInterval(poll);
      for (const t of timers.current) clearTimeout(t);
    };
  }, [tabAlert, startChime]);
  useEffect(() => {
    if (!blocked) return;
    const retry = () => void audio?.resume().then(() => setBlocked(audio?.state !== "running"));
    addEventListener("pointerdown", retry, { once: true });
    return () => removeEventListener("pointerdown", retry);
  }, [blocked]);
  if (!blocked) return null;
  return (
    <div class="toast" role="status" data-testid="chime-hint">
      The browser blocked the start chime. Click anywhere on the page to allow sound.
    </div>
  );
}
