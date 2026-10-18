// The booking link editor: settings, organizers and the round-robin pool
// (docs/specs/booking-links.md, booking-links-team.md). Co-organizers use it
// too; only the owner sees the URL and page fields.
import { useState } from "preact/hooks";
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
  use_recovery_buffer: number;
  branding: string;
  owner: { id: string; name: string; email: string };
  pageSlug: string | null;
  organizers: Organizer[];
  pool: PoolMember[];
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
};

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

export function LinkEditor({
  link,
  people,
  isOwner,
  onSaved,
  onClose,
}: {
  link: EditableLink;
  people: PersonOption[];
  isOwner: boolean;
  onSaved: (title: string) => void;
  onClose: () => void;
}) {
  const [organizers, setOrganizers] = useState<Organizer[]>(link.organizers);
  const [pool, setPool] = useState<PoolMember[]>(link.pool);
  const [error, setError] = useState<string | null>(null);
  const taken = new Set([...organizers, ...pool].map((p) => p.userId));
  const free = people.filter((p) => !taken.has(p.userId));
  const person = (userId: string): Person => {
    const p = people.find((x) => x.userId === userId);
    return { userId, name: p?.name ?? "", email: p?.email ?? "", hoursSetId: null };
  };
  const setOrganizer = (userId: string, change: Partial<Organizer>) =>
    setOrganizers(organizers.map((o) => (o.userId === userId ? { ...o, ...change } : o)));
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
          noticeMinutes: Number(f.get("notice")) * 60,
          rangeEndDays: Number(f.get("rangeEndDays")),
          bufferBefore: Number(f.get("bufferBefore")),
          bufferAfter: Number(f.get("bufferAfter")),
          maxPerDay: num("maxPerDay"),
          location: String(f.get("location") ?? ""),
          useRecoveryBuffer: f.get("useRecoveryBuffer") === "on",
          branding: String(f.get("branding")),
          ...(isOwner ? { slug: String(f.get("slug")), hidden: f.get("hidden") === "on" } : {}),
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
        Location
        <input name="location" defaultValue={link.location} />
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
          <label class="inline">
            <input name="hidden" type="checkbox" defaultChecked={link.hidden === 1} />
            Hide from my page (direct link only)
          </label>
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
      </div>

      <section class="wide" data-testid="organizers">
        <h3>Organizers</h3>
        <p class="status">
          Required organizers must be free. Optional organizers are invited but not checked. The
          host holds the event in their calendar.
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
