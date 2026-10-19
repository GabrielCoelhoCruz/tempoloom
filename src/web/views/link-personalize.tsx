// Personalize a booking link: a one-off link with its own settings, or chosen
// times to paste into a message (docs/specs/booking-links-sharing.md rules
// 8-22). Loaded on demand from the links page and from a one-off link's page.
import { useEffect, useMemo, useState } from "preact/hooks";
import { addDays, localToUtc, utcToLocal } from "../../shared/time.ts";
import { ApiError, api } from "../lib/api.ts";
import { DEFAULT_TEMPLATE, sharedTimes } from "../lib/shared-times.ts";
import { LEVEL_NAMES, zone as myZone } from "../lib/state.ts";
import { dayText, savedFormat, timeText, type View } from "../lib/zoned.ts";
import {
  type EditableLink,
  type Organizer,
  OrganizersEditor,
  type PersonOption,
} from "./link-editor.tsx";

const linkUrl = (l: EditableLink) => `${location.origin}/book/${l.pageSlug ?? ""}/${l.slug}`;

const copyText = (text: string) => navigator.clipboard?.writeText(text).catch(() => {});

const errorText = (err: unknown) => {
  const body =
    err instanceof ApiError
      ? (err.body as { error?: string; issues?: { message: string }[] } | undefined)
      : undefined;
  if (body?.error === "slug_taken") return "That URL name is taken.";
  return body?.issues?.[0]?.message ?? body?.error ?? String(err);
};

/**
 * The one-off link form (rules 9-10, 13): prefilled from the source link, or
 * from the one-off link being edited. "Copy link" saves it and copies its URL.
 */
export function OneOffForm({
  source,
  existing,
  people,
  onSaved,
}: {
  source: EditableLink;
  existing?: EditableLink;
  people: PersonOption[];
  onSaved?: (l: EditableLink) => void;
}) {
  const [saved, setSaved] = useState<EditableLink | undefined>(existing);
  const base = existing ?? source;
  const [organizers, setOrganizers] = useState<Organizer[]>(base.organizers);
  const [error, setError] = useState<string | null>(null);
  const taken = new Set([...organizers, ...base.pool].map((p) => p.userId));
  const free = people.filter((p) => !taken.has(p.userId));
  return (
    <form
      class="form"
      data-testid="oneoff-form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget as HTMLFormElement);
        const text = (k: string) => String(f.get(k) ?? "").trim();
        const durations = text("durations")
          .split(",")
          .map((d) => Number(d.trim()))
          .filter((d) => d > 0);
        const body = {
          inviteeName: text("inviteeName"),
          inviteeEmail: text("inviteeEmail"),
          title: text("title"),
          titleTemplate: text("titleTemplate"),
          level: Number(f.get("level")),
          durations,
          defaultDuration: text("defaultDuration") ? Number(text("defaultDuration")) : null,
          noticeMinutes: Number(f.get("notice")) * 60,
          rangeEndDays: Number(f.get("rangeEndDays")),
          useRecoveryBuffer: f.get("useRecoveryBuffer") === "on",
          location: text("location"),
          reminder: {
            enabled: f.get("reminderEnabled") === "on",
            hoursBefore: Number(f.get("reminderHours")),
            message: text("reminderMessage"),
          },
          organizers: organizers.map(({ userId, hoursSetId, required, isHost }) => ({
            userId,
            hoursSetId,
            required,
            isHost,
          })),
          ...(text("slug") ? { slug: text("slug") } : {}),
        };
        setError(null);
        const request = saved
          ? api<{ link: EditableLink }>("PATCH", `/api/booking/links/${saved.id}`, body)
          : api<{ link: EditableLink }>("POST", `/api/booking/links/${source.id}/oneoff`, body);
        request
          .then(({ link }) => {
            setSaved(link);
            if (!existing) void copyText(linkUrl(link));
            onSaved?.(link);
          })
          .catch((err) => setError(errorText(err)));
      }}
    >
      <p class="status wide">
        A one-off link changes the settings for one meeting. It is on no booking page, and the
        source link does not change. It works for 30 days.
      </p>
      <label>
        Invitee name
        <input name="inviteeName" maxLength={200} defaultValue={base.invitee_name ?? ""} />
      </label>
      <label>
        Invitee email
        <input name="inviteeEmail" type="email" defaultValue={base.invitee_email ?? ""} />
      </label>
      <label>
        Page title
        <input name="title" required maxLength={120} defaultValue={base.title} />
      </label>
      <label>
        Event title
        <input name="titleTemplate" required maxLength={200} defaultValue={base.title_template} />
      </label>
      <label>
        Priority
        <select name="level">
          {[1, 2, 3, 4].map((l) => (
            <option value={l} key={l} selected={l === base.level}>
              {LEVEL_NAMES[l]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Durations (minutes, comma list)
        <input name="durations" required defaultValue={base.durations.join(", ")} />
      </label>
      <label>
        Default duration (minutes)
        <input
          name="defaultDuration"
          type="number"
          min={5}
          defaultValue={base.default_duration ? String(base.default_duration) : ""}
        />
      </label>
      <label>
        Notice (hours)
        <input
          name="notice"
          type="number"
          min={0}
          defaultValue={String(base.notice_minutes / 60)}
        />
      </label>
      <label>
        Book up to (days ahead)
        <input
          name="rangeEndDays"
          type="number"
          min={0}
          max={100}
          defaultValue={String(base.range_end_days)}
        />
      </label>
      <label>
        Location
        <input name="location" defaultValue={base.location} />
      </label>
      <label>
        URL name
        <input
          name="slug"
          pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
          placeholder="random"
          defaultValue={saved?.slug ?? ""}
        />
      </label>
      <label class="inline">
        <input
          name="useRecoveryBuffer"
          type="checkbox"
          defaultChecked={base.use_recovery_buffer === 1}
        />
        Keep recovery buffers free
      </label>
      <label class="inline wide">
        <input
          name="reminderEnabled"
          type="checkbox"
          defaultChecked={base.reminder_enabled === 1}
        />
        Send a reminder email
      </label>
      <label>
        Hours before
        <input
          name="reminderHours"
          type="number"
          min={1}
          max={168}
          defaultValue={String(base.reminder_hours)}
        />
      </label>
      <label class="wide">
        Reminder message
        <textarea name="reminderMessage" rows={2} defaultValue={base.reminder_message} />
      </label>
      <OrganizersEditor
        organizers={organizers}
        people={people}
        free={free}
        onChange={setOrganizers}
      />
      {error && (
        <p class="error wide" role="alert">
          {error}
        </p>
      )}
      <div class="actions wide">
        <button type="submit" class="primary">
          {existing ? "Save" : "Copy link"}
        </button>
        {saved && !existing && (
          <>
            <code data-testid="oneoff-url">{linkUrl(saved)}</code>
            {saved.expiresAt && (
              <span
                class="status"
                data-testid="oneoff-expiry"
                data-date={utcToLocal(myZone(), saved.expiresAt).date}
              >
                Copied. Expires on {new Date(saved.expiresAt).toLocaleDateString()}.
              </span>
            )}
          </>
        )}
      </div>
    </form>
  );
}

const MAX_DATES = 5;
const DAYS = 14;

/** Shared times (rules 17-22): up to 5 dates, offered times, a format and a template. */
function ShareTimes({ link }: { link: EditableLink }) {
  const view: View = useMemo(() => ({ zone: myZone(), format: savedFormat() }), []);
  const [zone, setZone] = useState(view.zone);
  const v: View = { ...view, zone };
  const duration = link.default_duration ?? link.durations[0] ?? 30;
  const today = utcToLocal(zone, Date.now()).date;
  const dates = Array.from({ length: DAYS }, (_, i) => addDays(today, i));
  const [offered, setOffered] = useState<{ start: number; end: number }[]>([]);
  const [chosenDates, setChosenDates] = useState<string[]>([]);
  const [picked, setPicked] = useState<number[]>([]);
  const [style, setStyle] = useState<"buttons" | "text">("buttons");
  const [showRanges, setShowRanges] = useState(false);
  const [includeLinks, setIncludeLinks] = useState(true);
  const [template, setTemplate] = useState<string | null>(null);
  useEffect(() => {
    const from = localToUtc(zone, today, 0);
    const q = new URLSearchParams({
      duration: String(duration),
      from: String(from),
      to: String(localToUtc(zone, addDays(today, DAYS), 0)),
    });
    void api<{ times: { start: number; end: number }[] }>(
      "GET",
      `/pub/pages/${link.pageSlug}/${link.slug}/times?${q}`,
    ).then((r) => setOffered(r.times));
  }, [zone]);
  useEffect(() => {
    void api<{ timesTemplate: string | null }>("GET", "/api/booking/share-prefs").then((p) =>
      setTemplate(p.timesTemplate ?? DEFAULT_TEMPLATE),
    );
  }, []);
  const saveTemplate = (t: string) =>
    api("PUT", "/api/booking/share-prefs", { timesTemplate: t }).catch(() => {});
  const dayOfTime = (t: number) => utcToLocal(zone, t).date;
  const chosen = offered.filter((t) => picked.includes(t.start));
  const result = sharedTimes({
    times: chosen,
    zone,
    format: v.format,
    style,
    showRanges,
    includeLinks,
    template: template ?? DEFAULT_TEMPLATE,
    bookingUrl: linkUrl(link),
    duration,
    dayLabel: (t) => dayText(v, t),
  });
  if (template === null) return null;
  return (
    <div class="form" data-testid="share-times">
      <fieldset class="wide">
        <legend>Dates (up to {MAX_DATES})</legend>
        {dates.map((d) => {
          const on = chosenDates.includes(d);
          return (
            <label class="inline" key={d} data-date={d}>
              <input
                type="checkbox"
                checked={on}
                disabled={!on && chosenDates.length >= MAX_DATES}
                onChange={(e) => {
                  if (e.currentTarget.checked) setChosenDates([...chosenDates, d].sort());
                  else {
                    setChosenDates(chosenDates.filter((x) => x !== d));
                    setPicked(picked.filter((t) => dayOfTime(t) !== d));
                  }
                }}
              />
              {dayText(v, localToUtc(zone, d, 12 * 60))}
            </label>
          );
        })}
      </fieldset>
      {chosenDates.map((d) => {
        const times = offered.filter((t) => dayOfTime(t.start) === d);
        return (
          <fieldset class="wide" key={d} data-times-of={d}>
            <legend>{dayText(v, localToUtc(zone, d, 12 * 60))}</legend>
            {times.length === 0 && <span class="status">No offered times on this date.</span>}
            {times.map((t) => (
              <label class="inline" key={t.start} data-start={t.start}>
                <input
                  type="checkbox"
                  checked={picked.includes(t.start)}
                  onChange={(e) =>
                    setPicked(
                      e.currentTarget.checked
                        ? [...picked, t.start]
                        : picked.filter((x) => x !== t.start),
                    )
                  }
                />
                {timeText(v, t.start)}
              </label>
            ))}
          </fieldset>
        );
      })}
      <label>
        Time zone
        <input
          value={zone}
          onChange={(e) => {
            const z = e.currentTarget.value;
            try {
              new Intl.DateTimeFormat(undefined, { timeZone: z });
              setZone(z);
              setPicked([]);
              setChosenDates([]);
            } catch {}
          }}
        />
      </label>
      <div class="actions">
        <label class="inline">
          <input
            type="radio"
            name="style"
            checked={style === "buttons"}
            onChange={() => setStyle("buttons")}
          />
          Buttons
        </label>
        <label class="inline">
          <input
            type="radio"
            name="style"
            checked={style === "text"}
            onChange={() => setStyle("text")}
          />
          Text
        </label>
        <label class="inline">
          <input
            type="checkbox"
            checked={showRanges}
            onChange={(e) => setShowRanges(e.currentTarget.checked)}
          />
          Show start and end
        </label>
        <label class="inline">
          <input
            type="checkbox"
            checked={includeLinks}
            disabled={style !== "text"}
            onChange={(e) => setIncludeLinks(e.currentTarget.checked)}
          />
          Include links
        </label>
      </div>
      <label class="wide">
        Message template
        <textarea
          rows={3}
          value={template}
          onInput={(e) => setTemplate(e.currentTarget.value)}
          onBlur={(e) => void saveTemplate(e.currentTarget.value)}
        />
      </label>
      <p class="status wide">Variables: {"{times}, {link}, {duration}, {timezone}"}.</p>
      <div
        class="wide preview"
        data-testid="times-preview"
        // The HTML is built by sharedTimes, which escapes every text it inserts.
        dangerouslySetInnerHTML={{ __html: result.html }}
      />
      <div class="actions wide">
        <button
          type="button"
          class="primary"
          disabled={chosen.length === 0}
          onClick={() => {
            void saveTemplate(template);
            // Rule 21: HTML and plain text, so any app can paste it.
            void navigator.clipboard
              ?.write([
                new ClipboardItem({
                  "text/html": new Blob([result.html], { type: "text/html" }),
                  "text/plain": new Blob([result.text], { type: "text/plain" }),
                }),
              ])
              .catch(() => copyText(result.text));
          }}
        >
          Copy times
        </button>
      </div>
    </div>
  );
}

export function Personalize({
  link,
  people,
  onClose,
}: {
  link: EditableLink;
  people: PersonOption[];
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"oneoff" | "times">("oneoff");
  return (
    <section class="panel" data-testid="personalize">
      <h2>Personalize {link.title}</h2>
      <div class="actions">
        <button type="button" aria-pressed={tab === "oneoff"} onClick={() => setTab("oneoff")}>
          One-off link
        </button>
        <button type="button" aria-pressed={tab === "times"} onClick={() => setTab("times")}>
          Share times
        </button>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      {tab === "oneoff" ? <OneOffForm source={link} people={people} /> : <ShareTimes link={link} />}
    </section>
  );
}

/** Edit a one-off link from its own page (rule 13): the creator only. */
export function OneOffEditor({ linkId, onSaved }: { linkId: string; onSaved: () => void }) {
  const [data, setData] = useState<{ link: EditableLink; people: PersonOption[] } | null>(null);
  useEffect(() => {
    void Promise.all([
      api<{ link: EditableLink }>("GET", `/api/booking/links/${linkId}`),
      api<{ people: PersonOption[] }>("GET", "/api/booking/links"),
    ]).then(([l, all]) => setData({ link: l.link, people: all.people }));
  }, [linkId]);
  if (!data) return null;
  return (
    <OneOffForm source={data.link} existing={data.link} people={data.people} onSaved={onSaved} />
  );
}
