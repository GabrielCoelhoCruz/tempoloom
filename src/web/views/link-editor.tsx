// The booking link editor: settings, organizers and the round-robin pool
// (docs/specs/booking-links.md, booking-links-team.md). Co-organizers use it
// too; only the owner sees the URL and page fields.
import { useEffect, useState } from "preact/hooks";
import { ApiError, api } from "../lib/api.ts";
import { LEVEL_NAMES } from "../lib/state.ts";

export interface PersonOption {
  userId: string;
  name: string;
  email: string;
  hoursSets: { id: string; name: string }[];
}

interface Person {
  userId: string;
  name: string;
  email: string;
  hoursSetId: string | null;
}
export interface Organizer extends Person {
  required: boolean;
  isHost: boolean;
}
export interface PoolMember extends Person {
  preferred: boolean;
}

export interface Question {
  label: string;
  type: "singleLine" | "multiLine" | "choice";
  options: string[];
  required: boolean;
}

/** A question as the form edits it: the choices stay text until the save. */
interface QuestionDraft extends Omit<Question, "options"> {
  key: number;
  choices: string;
}

export interface EditableLink {
  id: string;
  slug: string;
  title: string;
  durations: number[];
  level: number;
  hidden: number;
  notice_minutes: number;
  range_end_days: number;
  buffer_before: number;
  buffer_after: number;
  max_per_day: number | null;
  location: string;
  locations: LocationOption[];
  range_end_date: string | null;
  calendar_id: string | null;
  use_travel_buffer: number;
  use_recovery_buffer: number;
  branding: string;
  questions: Question[];
  reminder_enabled: number;
  reminder_hours: number;
  reminder_message: string;
  redirect_url: string | null;
  /** "main", "hidden" or a link group id. */
  page: string;
  title_template: string;
  default_duration: number | null;
  invitee_name: string;
  invitee_email: string;
  /** One-off links: when the link stops working. */
  expiresAt: number | null;
  owner: { id: string; name: string; email: string };
  pageSlug: string | null;
  organizers: Organizer[];
  pool: PoolMember[];
}

export interface LocationOption {
  kind: "address" | "phone" | "custom";
  value: string;
}

const LOCATION_KINDS = [
  ["address", "Address"],
  ["phone", "Phone"],
  ["custom", "Other (text or URL)"],
] as const;

/** Location options of a link; the default is first (booking-links.md, location option). */
function LocationsEditor({
  locations,
  onChange,
}: {
  locations: LocationOption[];
  onChange: (l: LocationOption[]) => void;
}) {
  const set = (i: number, change: Partial<LocationOption>) =>
    onChange(locations.map((l, j) => (j === i ? { ...l, ...change } : l)));
  return (
    <section class="wide" data-testid="locations">
      <h3>Locations</h3>
      <p class="status">
        Bookers choose one when there are several. The default comes first. Video calls need a
        conference integration, which Tempoloom does not have: put a meeting room URL under Other.
      </p>
      <div class="list">
        {locations.map((l, i) => (
          <div class="row actions" key={i} data-testid={`location-${i + 1}`}>
            <label>
              Kind
              <select
                value={l.kind}
                onChange={(e) => set(i, { kind: e.currentTarget.value as LocationOption["kind"] })}
              >
                {LOCATION_KINDS.map(([v, label]) => (
                  <option value={v} key={v}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Location {i + 1}
              <input
                value={l.value}
                maxLength={500}
                onInput={(e) => set(i, { value: e.currentTarget.value })}
              />
            </label>
            <label class="inline">
              <input
                type="radio"
                name="defaultLocation"
                checked={i === 0}
                onChange={() => onChange([l, ...locations.filter((_, j) => j !== i)])}
              />
              Default
            </label>
            <button type="button" onClick={() => onChange(locations.filter((_, j) => j !== i))}>
              Remove location
            </button>
          </div>
        ))}
      </div>
      {locations.length < 10 && (
        <button
          type="button"
          onClick={() => onChange([...locations, { kind: "address", value: "" }])}
        >
          + Add location
        </button>
      )}
    </section>
  );
}

const BRANDINGS = [
  ["sameAsGroup", "Same as the page"],
  ["default", "Tempoloom logo"],
  ["none", "No logo"],
  ["custom", "Team logo and banner"],
] as const;

const ERRORS: Record<string, string> = {
  not_in_team: "Only members of the owner's team can join a link.",
  one_host: "Choose one host among the organizers.",
  host_required: "The host must be a required organizer.",
  pool_too_small: "A round-robin pool needs at least two people.",
  no_people: "Add an organizer, or at least two people to the pool.",
  duplicate_person: "A person can be an organizer or in the pool, not both.",
  slug_taken: "That URL name is taken.",
  forbidden: "Only the owner can change the URL or the page.",
  redirect_https: "The redirect URL must start with https://.",
  default_duration: "The default duration must be one of the durations.",
  calendar: "Choose one of your calendars that Tempoloom can write to.",
};

const ANSWER_TYPES = [
  ["singleLine", "Single line"],
  ["multiLine", "Several lines"],
  ["choice", "Choice"],
] as const;

/** Screening questions of a link (booking-links.md, question record). */
function QuestionsEditor({
  questions,
  onChange,
}: {
  questions: QuestionDraft[];
  onChange: (q: QuestionDraft[]) => void;
}) {
  const set = (key: number, change: Partial<QuestionDraft>) =>
    onChange(questions.map((q) => (q.key === key ? { ...q, ...change } : q)));
  return (
    <section class="wide" data-testid="questions">
      <h3>Questions</h3>
      <p class="status">Bookers answer these on the booking page. Answers go into the event.</p>
      <div class="list">
        {questions.map((q, i) => (
          <div class="row" key={q.key} data-testid={`question-${i + 1}`}>
            <div class="actions">
              <label>
                Question {i + 1}
                <input
                  value={q.label}
                  maxLength={300}
                  onInput={(e) => set(q.key, { label: e.currentTarget.value })}
                />
              </label>
              <label>
                Answer type
                <select
                  value={q.type}
                  onChange={(e) =>
                    set(q.key, { type: e.currentTarget.value as QuestionDraft["type"] })
                  }
                >
                  {ANSWER_TYPES.map(([value, label]) => (
                    <option value={value} key={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {q.type === "choice" && (
                <label>
                  Choices (comma list)
                  <input
                    value={q.choices}
                    onInput={(e) => set(q.key, { choices: e.currentTarget.value })}
                  />
                </label>
              )}
              <label class="inline">
                <input
                  type="checkbox"
                  checked={q.required}
                  onChange={(e) => set(q.key, { required: e.currentTarget.checked })}
                />
                Required
              </label>
            </div>
            <button
              type="button"
              onClick={() => onChange(questions.filter((x) => x.key !== q.key))}
            >
              Remove question
            </button>
          </div>
        ))}
      </div>
      {questions.length < 10 && (
        <button
          type="button"
          onClick={() =>
            onChange([
              ...questions,
              {
                key: Math.max(0, ...questions.map((q) => q.key)) + 1,
                label: "",
                type: "singleLine",
                choices: "",
                required: false,
              },
            ])
          }
        >
          + Add question
        </button>
      )}
    </section>
  );
}

const toDrafts = (questions: Question[]): QuestionDraft[] =>
  questions.map(({ options, ...q }, i) => ({ ...q, key: i + 1, choices: options.join(", ") }));

const fromDrafts = (drafts: QuestionDraft[]): Question[] =>
  drafts
    .filter((q) => q.label.trim())
    .map(({ key: _key, choices, ...q }) => ({
      ...q,
      label: q.label.trim(),
      options:
        q.type === "choice"
          ? choices
              .split(",")
              .map((c) => c.trim())
              .filter(Boolean)
          : [],
    }));

function HoursPicker({
  person,
  people,
  onChange,
}: {
  person: Person;
  people: PersonOption[];
  onChange: (id: string | null) => void;
}) {
  const sets = people.find((p) => p.userId === person.userId)?.hoursSets ?? [];
  return (
    <label>
      Hours
      <select
        value={person.hoursSetId ?? ""}
        onChange={(e) => onChange(e.currentTarget.value || null)}
      >
        <option value="">Their meeting hours</option>
        {sets.map((h) => (
          <option value={h.id} key={h.id}>
            {h.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The organizers of a link, each with their hours, required flag and host
 * (booking-links-team.md rules 1-3). Used by the link editor and one-off links.
 */
export function OrganizersEditor({
  organizers,
  people,
  free,
  onChange,
}: {
  organizers: Organizer[];
  people: PersonOption[];
  /** Team members who can still be added. */
  free: PersonOption[];
  onChange: (o: Organizer[]) => void;
}) {
  const setOrganizers = onChange;
  const setOrganizer = (userId: string, change: Partial<Organizer>) =>
    setOrganizers(organizers.map((o) => (o.userId === userId ? { ...o, ...change } : o)));
  const person = (userId: string): Person => {
    const p = people.find((x) => x.userId === userId);
    return { userId, name: p?.name ?? "", email: p?.email ?? "", hoursSetId: null };
  };
  return (
    <section class="wide" data-testid="organizers">
      <h3>Organizers</h3>
      <p class="status">
        Required organizers must be free. Optional organizers are invited but not checked. The host
        holds the event in their calendar.
      </p>
      <div class="list">
        {organizers.map((o) => (
          <div class="row" key={o.userId} data-organizer={o.email}>
            <div class="actions">
              <span>
                {o.name} ({o.email})
              </span>
              <HoursPicker
                person={o}
                people={people}
                onChange={(id) => setOrganizer(o.userId, { hoursSetId: id })}
              />
              <label class="inline">
                <input
                  type="checkbox"
                  checked={o.required}
                  onChange={(e) => setOrganizer(o.userId, { required: e.currentTarget.checked })}
                />
                Required
              </label>
              <label class="inline">
                <input
                  type="radio"
                  name="host"
                  checked={o.isHost}
                  onChange={() =>
                    setOrganizers(
                      organizers.map((x) => ({
                        ...x,
                        isHost: x.userId === o.userId,
                        required: x.userId === o.userId ? true : x.required,
                      })),
                    )
                  }
                />
                Host
              </label>
            </div>
            <button
              type="button"
              onClick={() => {
                const rest = organizers.filter((x) => x.userId !== o.userId);
                if (o.isHost && rest[0]) rest[0] = { ...rest[0], isHost: true, required: true };
                setOrganizers(rest);
              }}
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <div class="actions">
        <label>
          Add organizer
          <select
            value=""
            onChange={(e) => {
              const id = e.currentTarget.value;
              if (!id) return;
              setOrganizers([
                ...organizers,
                { ...person(id), required: true, isHost: organizers.length === 0 },
              ]);
            }}
          >
            <option value="">Choose a team member</option>
            {free.map((p) => (
              <option value={p.userId} key={p.userId}>
                {p.email}
              </option>
            ))}
          </select>
        </label>
        <a href="/team">Invite someone to the team</a>
      </div>
    </section>
  );
}

export function LinkEditor({
  link,
  groups,
  people,
  isOwner,
  onSaved,
  onClose,
}: {
  link: EditableLink;
  groups: { id: string; title: string }[];
  people: PersonOption[];
  isOwner: boolean;
  onSaved: (title: string) => void;
  onClose: () => void;
}) {
  const [organizers, setOrganizers] = useState<Organizer[]>(link.organizers);
  const [pool, setPool] = useState<PoolMember[]>(link.pool);
  const [questions, setQuestions] = useState<QuestionDraft[]>(() => toDrafts(link.questions));
  const [pageChoice, setPageChoice] = useState(link.page);
  const [locations, setLocations] = useState<LocationOption[]>(link.locations);
  const [calendars, setCalendars] = useState<{ id: string; name: string; email: string }[]>([]);
  useEffect(() => {
    void api<{ calendars: { id: string; name: string; email: string; writable: number }[] }>(
      "GET",
      "/api/calendars",
    ).then((r) => setCalendars(r.calendars.filter((c) => c.writable)));
  }, []);
  // Main and hidden links share the main page URL; a group has its own (sharing rule 5).
  const urlPage = (p: string) => (p === "main" || p === "hidden" ? "" : p);
  const [error, setError] = useState<string | null>(null);
  const taken = new Set([...organizers, ...pool].map((p) => p.userId));
  const free = people.filter((p) => !taken.has(p.userId));
  const person = (userId: string): Person => {
    const p = people.find((x) => x.userId === userId);
    return { userId, name: p?.name ?? "", email: p?.email ?? "", hoursSetId: null };
  };
  const setMember = (userId: string, change: Partial<PoolMember>) =>
    setPool(pool.map((m) => (m.userId === userId ? { ...m, ...change } : m)));
  const several = organizers.length + (pool.length > 0 ? 1 : 0) > 1;

  return (
    <form
      class="form"
      data-testid="link-editor"
      key={link.id}
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget as HTMLFormElement);
        const num = (k: string) => (f.get(k) === "" || f.get(k) === null ? null : Number(f.get(k)));
        setError(null);
        api("PATCH", `/api/booking/links/${link.id}`, {
          title: String(f.get("title") ?? ""),
          durations: String(f.get("durations") ?? "")
            .split(",")
            .map((d) => Number(d.trim()))
            .filter((d) => d > 0),
          level: Number(f.get("level")),
          defaultDuration: num("defaultDuration"),
          noticeMinutes: Number(f.get("notice")) * 60,
          rangeEndDays: Number(f.get("rangeEndDays")),
          rangeEndDate: String(f.get("rangeEndDate") ?? "") || null,
          bufferBefore: Number(f.get("bufferBefore")),
          bufferAfter: Number(f.get("bufferAfter")),
          maxPerDay: num("maxPerDay"),
          locations: locations.map((l) => ({ ...l, value: l.value.trim() })).filter((l) => l.value),
          useRecoveryBuffer: f.get("useRecoveryBuffer") === "on",
          useTravelBuffer: f.get("useTravelBuffer") === "on",
          ...(isOwner ? { calendarId: String(f.get("calendarId") ?? "") || null } : {}),
          branding: String(f.get("branding")),
          questions: fromDrafts(questions),
          reminder: {
            enabled: f.get("reminderEnabled") === "on",
            hoursBefore: Number(f.get("reminderHours")),
            message: String(f.get("reminderMessage") ?? ""),
          },
          redirectUrl: String(f.get("redirectUrl") ?? ""),
          ...(isOwner ? { slug: String(f.get("slug")), page: pageChoice } : {}),
          organizers: organizers.map(({ userId, hoursSetId, required, isHost }) => ({
            userId,
            hoursSetId,
            required,
            isHost,
          })),
          pool: pool.map(({ userId, hoursSetId, preferred }) => ({
            userId,
            hoursSetId,
            preferred,
          })),
        })
          .then(() => onSaved(String(f.get("title") ?? "")))
          .catch((err) => {
            const body =
              err instanceof ApiError
                ? (err.body as { error?: string; issues?: { message: string }[] })
                : undefined;
            setError(
              ERRORS[body?.error ?? ""] ?? body?.issues?.[0]?.message ?? body?.error ?? String(err),
            );
          });
      }}
    >
      <h2 class="wide">Edit {link.title}</h2>
      {!isOwner && (
        <p class="wide status" data-testid="owner-note">
          Owned by {link.owner.name} ({link.owner.email}). Only they can change the URL, the page or
          delete the link.
        </p>
      )}
      <label class="wide">
        Title
        <input name="title" required maxLength={120} defaultValue={link.title} />
      </label>
      <label>
        Durations (minutes, comma list)
        <input name="durations" required defaultValue={link.durations.join(", ")} />
      </label>
      <label>
        Default duration (minutes)
        <input
          name="defaultDuration"
          type="number"
          min={5}
          step={5}
          placeholder="the first one"
          defaultValue={link.default_duration === null ? "" : String(link.default_duration)}
        />
      </label>
      <label>
        Priority
        <select name="level">
          {[1, 2, 3, 4].map((l) => (
            <option value={l} key={l} selected={l === link.level}>
              {LEVEL_NAMES[l]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Notice (hours)
        <input
          name="notice"
          type="number"
          min={0}
          defaultValue={String(link.notice_minutes / 60)}
        />
      </label>
      <label>
        Book up to (days ahead)
        <input
          name="rangeEndDays"
          type="number"
          min={0}
          max={100}
          defaultValue={String(link.range_end_days)}
        />
      </label>
      <label>
        Or up to a date
        <input name="rangeEndDate" type="date" defaultValue={link.range_end_date ?? ""} />
      </label>
      <label>
        Buffer before (minutes)
        <input
          name="bufferBefore"
          type="number"
          min={0}
          max={120}
          defaultValue={String(link.buffer_before)}
        />
      </label>
      <label>
        Buffer after (minutes)
        <input
          name="bufferAfter"
          type="number"
          min={0}
          max={120}
          defaultValue={String(link.buffer_after)}
        />
      </label>
      <label>
        Most bookings per day
        <input
          name="maxPerDay"
          type="number"
          min={1}
          max={50}
          defaultValue={link.max_per_day === null ? "" : String(link.max_per_day)}
        />
      </label>
      <label>
        Branding
        <select name="branding">
          {BRANDINGS.map(([value, label]) => (
            <option value={value} key={value} selected={value === link.branding}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {isOwner && (
        <label>
          Calendar for booked events
          <select name="calendarId">
            <option value="">Main calendar</option>
            {calendars.map((c) => (
              <option value={c.id} key={c.id} selected={c.id === link.calendar_id}>
                {c.name} ({c.email})
              </option>
            ))}
          </select>
        </label>
      )}
      {isOwner && (
        <>
          <label>
            URL name
            <input
              name="slug"
              required
              pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
              defaultValue={link.slug}
            />
          </label>
          <div class="field">
            <label for={`page-${link.id}`}>Page</label>
            <select
              id={`page-${link.id}`}
              value={pageChoice}
              onChange={(e) => setPageChoice(e.currentTarget.value)}
            >
              <option value="main">Main page</option>
              <option value="hidden">Hidden (direct link only)</option>
              {groups.map((g) => (
                <option value={g.id} key={g.id}>
                  {g.title}
                </option>
              ))}
            </select>
          </div>
          {urlPage(pageChoice) !== urlPage(link.page) && (
            <p class="error wide" data-testid="page-warning">
              Moving the link to another page changes its URL. The URL you shared before will stop
              working.
            </p>
          )}
        </>
      )}
      <div class="wide">
        <label class="inline">
          <input
            name="useRecoveryBuffer"
            type="checkbox"
            defaultChecked={link.use_recovery_buffer === 1}
          />
          Keep recovery buffers free
        </label>
        <p class="status">
          The longest recovery buffer among the people of the link stays free after each meeting.
          {several && " Turn this off to offer more times on a link with several people."}
        </p>
        <label class="inline">
          <input
            name="useTravelBuffer"
            type="checkbox"
            defaultChecked={link.use_travel_buffer === 1}
          />
          Keep travel time free
        </label>
        <p class="status">
          When the default location is an address, each person's travel time before and after stays
          free.
        </p>
      </div>

      <LocationsEditor locations={locations} onChange={setLocations} />

      <QuestionsEditor questions={questions} onChange={setQuestions} />

      <section class="wide form" data-testid="reminder">
        <h3 class="wide">Reminder and redirect</h3>
        <label class="inline wide">
          <input
            name="reminderEnabled"
            type="checkbox"
            defaultChecked={link.reminder_enabled === 1}
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
            defaultValue={String(link.reminder_hours)}
          />
        </label>
        <label class="wide">
          Reminder message
          <textarea
            name="reminderMessage"
            rows={2}
            maxLength={1024}
            defaultValue={link.reminder_message}
          />
        </label>
        <label class="wide">
          Redirect after booking (https URL)
          <input name="redirectUrl" defaultValue={link.redirect_url ?? ""} />
        </label>
        <p class="status wide">
          The booking page shows the confirmation, then opens this page 7 seconds later.
        </p>
      </section>

      <OrganizersEditor
        organizers={organizers}
        people={people}
        free={free}
        onChange={setOrganizers}
      />

      <section class="wide" data-testid="pool">
        <h3>Round-robin pool</h3>
        <p class="status">
          With two or more people here, the link offers a time when one of them is free and books
          the meeting with one of them. Preferred people are chosen first, then the one with the
          fewest bookings.
        </p>
        <div class="list">
          {pool.map((m) => (
            <div class="row" key={m.userId} data-pool-member={m.email}>
              <div class="actions">
                <span>
                  {m.name} ({m.email})
                </span>
                <HoursPicker
                  person={m}
                  people={people}
                  onChange={(id) => setMember(m.userId, { hoursSetId: id })}
                />
                <label class="inline">
                  <input
                    type="checkbox"
                    checked={m.preferred}
                    onChange={(e) => setMember(m.userId, { preferred: e.currentTarget.checked })}
                  />
                  Preferred
                </label>
              </div>
              <button
                type="button"
                onClick={() => setPool(pool.filter((x) => x.userId !== m.userId))}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <label>
          Add to pool
          <select
            value=""
            onChange={(e) => {
              const id = e.currentTarget.value;
              if (id) setPool([...pool, { ...person(id), preferred: false }]);
            }}
          >
            <option value="">Choose a team member</option>
            {free.map((p) => (
              <option value={p.userId} key={p.userId}>
                {p.email}
              </option>
            ))}
          </select>
        </label>
      </section>

      {error && (
        <p class="error wide" role="alert">
          {error}
        </p>
      )}
      <div class="actions wide">
        <button type="submit" class="primary">
          Save link
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
