// Settings for meetings: start-time intervals (meetings-start-intervals.md),
// meeting emails (planning-notifications.md NTF-20 to NTF-30) and the weekly
// no-meeting day (events-tags.md, library entry 33).
import { useCallback, useEffect, useState } from "preact/hooks";
import type { MeetingPrefs } from "../../server/meeting-prefs.ts";
import { api } from "../lib/api.ts";
import { templateFromUrl } from "../lib/library.ts";
import { messageOf, useSave } from "../lib/save.ts";
import { planNow } from "../lib/state.ts";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function MeetingSettings() {
  const [prefs, setPrefs] = useState<MeetingPrefs | null>(null);
  const [noMeeting, setNoMeeting] = useState<number | null | undefined>(undefined);
  const template = templateFromUrl();
  const [day, setDay] = useState(template?.kind === "no_meeting_day" ? template.preset.weekday : 3);
  const times = useSave();
  const emails = useSave();
  const [dayError, setDayError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [p, n] = await Promise.all([
      api<{ prefs: MeetingPrefs }>("GET", "/api/meeting-checks"),
      api<{ weekday: number | null }>("GET", "/api/no-meeting-day"),
    ]);
    setPrefs(p.prefs);
    setNoMeeting(n.weekday);
  }, []);
  useEffect(() => void load(), [load]);

  if (!prefs || noMeeting === undefined) return null;

  const patch = async (body: Partial<MeetingPrefs>) => {
    const res = await api<{ prefs: MeetingPrefs }>("PATCH", "/api/meeting-prefs", body);
    setPrefs(res.prefs);
  };

  return (
    <>
      <section>
        <h2>Meeting start times</h2>
        <form
          class="form"
          data-testid="start-times"
          onInput={times.reset}
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget as HTMLFormElement);
            const minutes = f.getAll("minute").map(Number) as MeetingPrefs["startMinutes"];
            void times.save(() => patch({ startMinutes: minutes }));
          }}
        >
          <fieldset class="wide days">
            <legend>Flexible meetings and booking links may start at</legend>
            {[0, 15, 30, 45].map((m) => (
              <label class="inline" key={m}>
                <input
                  type="checkbox"
                  name="minute"
                  value={m}
                  defaultChecked={prefs.startMinutes.includes(m as 0)}
                />
                :{String(m).padStart(2, "0")}
              </label>
            ))}
          </fieldset>
          <p class="meta wide">Meetings placed before a change keep their time.</p>
          {typeof times.state === "object" && (
            <p class="error wide" role="alert">
              {times.state.error}
            </p>
          )}
          <div class="actions wide">
            <button type="submit">Save start times</button>
            {times.state === "saved" && (
              <span class="status" data-testid="start-times-saved">
                Saved
              </span>
            )}
          </div>
        </form>
      </section>

      <section>
        <h2>Meeting emails</h2>
        <form
          class="form"
          data-testid="meeting-emails"
          onInput={emails.reset}
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget as HTMLFormElement);
            void emails.save(() =>
              patch({
                meetingChangeEmails: f.get("guests") === "on",
                meetingChangeDaysAhead: Number(f.get("days")),
                atRiskDigest: f.get("atRisk") === "on",
                newSeriesEmail: f.get("newSeries") === "on",
                dailyTime: String(f.get("dailyTime")),
              }),
            );
          }}
        >
          <label class="inline wide">
            <input type="checkbox" name="guests" defaultChecked={prefs.meetingChangeEmails} />
            Email guests when Tempoloom moves or cancels a meeting
          </label>
          <label>
            Only for meetings in the next (days)
            <input
              name="days"
              type="number"
              min={0}
              max={30}
              defaultValue={String(prefs.meetingChangeDaysAhead)}
            />
          </label>
          <label class="inline wide">
            <input type="checkbox" name="atRisk" defaultChecked={prefs.atRiskDigest} />
            Daily email about meetings at risk
          </label>
          <label class="inline wide">
            <input type="checkbox" name="newSeries" defaultChecked={prefs.newSeriesEmail} />
            Email me about new recurring meetings
          </label>
          <label>
            Send daily emails at
            <input name="dailyTime" type="time" required defaultValue={prefs.dailyTime} />
          </label>
          {typeof emails.state === "object" && (
            <p class="error wide" role="alert">
              {emails.state.error}
            </p>
          )}
          <div class="actions wide">
            <button type="submit">Save meeting emails</button>
            {emails.state === "saved" && (
              <span class="status" data-testid="meeting-emails-saved">
                Saved
              </span>
            )}
          </div>
        </form>
      </section>

      <section data-testid="no-meeting-day">
        <h2>Weekly no-meeting day</h2>
        <p class="meta">
          Tempoloom adds a weekly all-day busy event with #tl_free. Tasks and habits may use the
          day; flexible meetings and booking links stay off it.
        </p>
        {noMeeting === null ? (
          <div class="actions">
            <label>
              Day
              <select value={String(day)} onChange={(e) => setDay(Number(e.currentTarget.value))}>
                {WEEKDAYS.map((name, i) => (
                  <option value={String(i + 1)} key={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => {
                setDayError(null);
                api("POST", "/api/no-meeting-day", { weekday: day })
                  .then(planNow)
                  .then(load, (err) => setDayError(messageOf(err)));
              }}
            >
              Add no-meeting day
            </button>
          </div>
        ) : (
          <div class="row">
            <span>No meetings on {WEEKDAYS[noMeeting - 1]}s</span>
            <button
              type="button"
              class="danger"
              onClick={() => {
                setDayError(null);
                api("DELETE", "/api/no-meeting-day")
                  .then(planNow)
                  .then(load, (err) => setDayError(messageOf(err)));
              }}
            >
              Remove no-meeting day
            </button>
          </div>
        )}
        {dayError && (
          <p class="error" role="alert">
            {dayError}
          </p>
        )}
      </section>
    </>
  );
}
