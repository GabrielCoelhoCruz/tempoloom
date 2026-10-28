import { Fragment } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import { CalendarDisconnected } from "../lib/calendars.tsx";
import { formatWhen } from "../lib/format.ts";
import { lazyComponent } from "../lib/lazy.ts";
import { freeName, templateFromUrl } from "../lib/library.ts";
import { LEVEL_NAMES, me, zone } from "../lib/state.ts";
import { type EditableLink, LinkEditor, type PersonOption } from "./link-editor.tsx";
import { type Group, GroupDelete, GroupEditor, GroupForm } from "./link-groups.tsx";
import "./pages.css";

// Personalize (one-off links and shared times) loads on first use.
const Personalize = lazyComponent<{
  link: EditableLink;
  people: PersonOption[];
  onClose: () => void;
}>(() => import("./link-personalize.tsx").then((m) => m.Personalize));
const SharePanel = lazyComponent<{ title: string; url: string; onClose: () => void }>(() =>
  import("./link-share.tsx").then((m) => m.SharePanel),
);

interface Endpoint {
  id: string;
  name: string;
  link_ids: string[];
}

interface Booking {
  id: string;
  start_ms: number;
  name: string;
  email: string;
  status: string;
  link_title: string | null;
}

interface DirectoryMember {
  name: string;
  email: string;
  page: string | null;
  links: { title: string; slug: string; durations: number[] }[];
}

const bookUrl = (page: string, slug?: string) =>
  `${location.origin}/book/${page}${slug ? `/${slug}` : ""}`;

const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});

/** Who joins a link besides its owner, for the link cards. */
function peopleLine(l: EditableLink): string | null {
  const others = l.organizers.filter((o) => o.userId !== l.owner.id).map((o) => o.email);
  if (l.pool.length > 0)
    return `Round robin: ${l.pool.map((m) => `${m.email}${m.preferred ? " (preferred)" : ""}`).join(", ")}`;
  return others.length > 0 ? `With ${others.join(", ")}` : null;
}

/** Every team member's booking page and public links (teams-executive-assistant-use rule 5). */
function BookingDirectory() {
  const [members, setMembers] = useState<DirectoryMember[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    void api<{ members: DirectoryMember[] }>("GET", "/api/booking/directory").then((r) =>
      setMembers(r.members),
    );
  }, []);
  if (!members) return null;
  return (
    <div data-testid="booking-directory">
      <p class="status">Copy a teammate's link to share it for them.</p>
      {copied && (
        <p class="status">
          Copied: <code data-testid="directory-copied">{copied}</code>
        </p>
      )}
      <div class="list">
        {members.map((m) => (
          <div class="row" key={m.email} data-member={m.email}>
            <div>
              <div>
                {m.name} ({m.email})
              </div>
              {m.page ? (
                <div class="meta">
                  <a href={bookUrl(m.page)}>{bookUrl(m.page)}</a>
                </div>
              ) : (
                <div class="meta">No booking page yet.</div>
              )}
              {m.page &&
                m.links.map((l) => (
                  <div class="actions" key={l.slug} data-directory-link={l.title}>
                    <span>
                      {l.title} · {l.durations.join(", ")} min
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        const url = bookUrl(m.page ?? "", l.slug);
                        copy(url);
                        setCopied(url);
                      }}
                    >
                      Copy link
                    </button>
                  </div>
                ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Links() {
  const z = zone();
  const [tab, setTab] = useState<"mine" | "directory">("mine");
  const [page, setPage] = useState<string | null | undefined>(undefined);
  const [pageBranding, setPageBranding] = useState<string | null>(null);
  const [brandingSaved, setBrandingSaved] = useState(false);
  const [links, setLinks] = useState<EditableLink[]>([]);
  const [teamLinks, setTeamLinks] = useState<EditableLink[]>([]);
  const [people, setPeople] = useState<PersonOption[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [personalizing, setPersonalizing] = useState<string | null>(null);
  const [sharing, setSharing] = useState<string | null>(null);
  const [groupForm, setGroupForm] = useState(false);
  const [groupAction, setGroupAction] = useState<{ id: string; kind: "edit" | "delete" } | null>(
    null,
  );
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [p, l, w] = await Promise.all([
      api<{ slug: string | null; branding: string | null }>("GET", "/api/booking/page"),
      api<{
        links: EditableLink[];
        groups: Group[];
        teamLinks: EditableLink[];
        people: PersonOption[];
      }>("GET", "/api/booking/links"),
      api<{ endpoints: Endpoint[] }>("GET", "/api/webhooks"),
    ]);
    setPage(p.slug);
    setPageBranding(p.branding);
    setLinks(l.links);
    setGroups(l.groups);
    setTeamLinks(l.teamLinks);
    setPeople(l.people);
    setEndpoints(w.endpoints);
    if (p.slug) {
      const b = await api<{ bookings: Booking[] }>("GET", "/api/booking/bookings");
      setBookings(b.bookings);
    }
  }, []);
  useEffect(() => void load(), [load]);
  // ?edit=<link id> opens that link's editor, for links from the availability inspector.
  useEffect(() => {
    const id = new URLSearchParams(location.search).get("edit");
    if (id) setEditing(id);
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      const body = (err as { body?: { error?: string; issues?: { message: string }[] } }).body;
      setError(body?.issues?.[0]?.message ?? body?.error ?? String(err));
    }
  };

  if (page === undefined) return null;
  const edited = [...links, ...teamLinks].find((l) => l.id === editing);
  const myId = me.value?.user.id;
  const shareButton = (l: EditableLink) => (
    <button
      type="button"
      onClick={() => {
        setEditing(null);
        setPersonalizing(null);
        setSharing(l.id);
      }}
    >
      Share
    </button>
  );
  const personalizeButton = (l: EditableLink) => (
    <button
      type="button"
      onClick={() => {
        setEditing(null);
        setSharing(null);
        setPersonalizing(l.id);
      }}
    >
      Personalize
    </button>
  );
  const editButton = (l: EditableLink) => (
    <button
      type="button"
      onClick={() => {
        setSaved(null);
        setPersonalizing(null);
        setSharing(null);
        setEditing(l.id);
      }}
    >
      Edit
    </button>
  );

  const choices = links.map((l) => ({ id: l.id, title: l.title, page: l.page }));
  /** One card per link (booking-links.md rule 5): what it is and what you can do with it. */
  const card = (l: EditableLink) => {
    const url = bookUrl(l.pageSlug ?? page ?? "", l.slug);
    return (
      <div
        class="row"
        key={l.id}
        data-testid="link-row"
        data-link-title={l.title}
        data-link-id={l.id}
      >
        <div>
          <div>
            {l.title} {l.hidden ? <span class="badge">hidden</span> : null}
          </div>
          <div class="meta">
            {LEVEL_NAMES[l.level]} · {l.durations.join(", ")} min ·{" "}
            <a href={url} data-testid="link-url">
              {url}
            </a>
          </div>
          {peopleLine(l) && <div class="meta">{peopleLine(l)}</div>}
          {l.targetError ? (
            <p class="error" role="alert" data-testid="link-target-error">
              {l.targetError}
            </p>
          ) : (
            <CalendarDisconnected email={l.disconnected} />
          )}
          {endpoints.length > 0 && (
            <div class="meta" data-testid="link-webhooks">
              Send webhooks to:{" "}
              {endpoints.map((e) => (
                <label class="inline" key={e.id}>
                  <input
                    type="checkbox"
                    checked={e.link_ids.includes(l.id)}
                    onChange={(ev) => {
                      const on = ev.currentTarget.checked;
                      const ids = endpoints
                        .filter((x) => (x.id === e.id ? on : x.link_ids.includes(l.id)))
                        .map((x) => x.id);
                      void act(() =>
                        api("PUT", `/api/booking/links/${l.id}/webhooks`, { endpointIds: ids }),
                      );
                    }}
                  />
                  {e.name}
                </label>
              ))}
            </div>
          )}
        </div>
        <div class="actions">
          <label class="inline">
            Priority
            <select
              value={String(l.level)}
              onChange={(e) => {
                const level = Number(e.currentTarget.value);
                void act(() => api("PATCH", `/api/booking/links/${l.id}`, { level }));
              }}
            >
              {[1, 2, 3, 4].map((n) => (
                <option value={n} key={n}>
                  {LEVEL_NAMES[n]}
                </option>
              ))}
            </select>
          </label>
          <a href={url} target="_blank" rel="noopener">
            Open booking page
          </a>
          <button type="button" onClick={() => copy(url)}>
            Copy link
          </button>
          {editButton(l)}
          {personalizeButton(l)}
          {shareButton(l)}
          <button
            type="button"
            class="danger"
            onClick={() => void act(() => api("DELETE", `/api/booking/links/${l.id}`))}
          >
            Delete
          </button>
        </div>
      </div>
    );
  };
  /** The personalize or share panel of a link, right under its card. */
  const panels = (l: EditableLink, url: string) => (
    <>
      {sharing === l.id && (
        <SharePanel title={l.title} url={url} onClose={() => setSharing(null)} />
      )}
      {personalizing === l.id && (
        <Personalize link={l} people={people} onClose={() => setPersonalizing(null)} />
      )}
    </>
  );
  const cards = (list: EditableLink[]) => (
    <div class="list">
      {list.map((l) => (
        <Fragment key={l.id}>
          {card(l)}
          {panels(l, bookUrl(l.pageSlug ?? page ?? "", l.slug))}
        </Fragment>
      ))}
      {list.length === 0 && <p class="status">No links here.</p>}
    </div>
  );

  const template = templateFromUrl();
  const preset = template?.kind === "booking_link" ? template.preset : null;
  const mine = page ? (
    <>
      <p class="status">
        Your page:{" "}
        <a href={bookUrl(page)} data-testid="page-url">
          {bookUrl(page)}
        </a>
      </p>
      <div class="actions">
        <label>
          Page branding
          <select
            value={pageBranding ?? "default"}
            onChange={(e) => {
              const branding = e.currentTarget.value;
              setBrandingSaved(false);
              void act(async () => {
                await api("PUT", "/api/booking/page/branding", { branding });
                setBrandingSaved(true);
              });
            }}
          >
            <option value="default">Tempoloom logo</option>
            <option value="none">No logo</option>
            <option value="custom">Team logo and banner</option>
          </select>
        </label>
        {brandingSaved && (
          <span class="status" data-testid="page-branding-saved">
            Saved
          </span>
        )}
      </div>
      <form
        class="form"
        data-testid="link-form"
        key={template ? `${template.slug}-${links.length}` : "new"}
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget as HTMLFormElement);
          const num = (k: string) =>
            f.get(k) === "" || f.get(k) === null ? null : Number(f.get(k));
          const durations = String(f.get("durations") ?? "")
            .split(",")
            .map((d) => Number(d.trim()))
            .filter((d) => d > 0);
          void act(() =>
            api("POST", "/api/booking/links", {
              title: String(f.get("title") ?? ""),
              durations,
              level: Number(f.get("level")),
              noticeMinutes: Number(f.get("notice")) * 60,
              rangeEndDays: Number(f.get("rangeEndDays")),
              bufferBefore: Number(f.get("bufferBefore")),
              bufferAfter: Number(f.get("bufferAfter")),
              maxPerDay: num("maxPerDay"),
              page: String(f.get("page") ?? "main"),
            }),
          );
        }}
      >
        <label class="wide">
          Title
          <input
            name="title"
            required
            maxLength={120}
            defaultValue={
              template
                ? freeName(
                    template.name,
                    links.map((l) => l.title),
                  )
                : ""
            }
          />
        </label>
        <label>
          Durations (minutes, comma list)
          <input name="durations" defaultValue={preset?.durations ?? "30"} required />
        </label>
        <label>
          Priority
          <select name="level">
            {[1, 2, 3, 4].map((l) => (
              <option value={l} key={l} selected={l === (preset?.level ?? 2)}>
                {LEVEL_NAMES[l]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Notice (hours)
          <input name="notice" type="number" min={0} defaultValue="4" />
        </label>
        <label>
          Book up to (days ahead)
          <input name="rangeEndDays" type="number" min={0} max={100} defaultValue="30" />
        </label>
        <label>
          Buffer before (minutes)
          <input name="bufferBefore" type="number" min={0} max={120} defaultValue="0" />
        </label>
        <label>
          Buffer after (minutes)
          <input name="bufferAfter" type="number" min={0} max={120} defaultValue="0" />
        </label>
        <label>
          Most bookings per day
          <input name="maxPerDay" type="number" min={1} max={50} />
        </label>
        <div class="field">
          <label for="new-link-page">Page</label>
          <select id="new-link-page" name="page">
            <option value="main">Main page</option>
            <option value="hidden">Hidden (direct link only)</option>
            {groups.map((g) => (
              <option value={g.id} key={g.id}>
                {g.title}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" class="primary">
          Add link
        </button>
      </form>
      <div class="actions">
        <button
          type="button"
          onClick={() => {
            setGroupForm(true);
            setGroupAction(null);
          }}
        >
          New group
        </button>
      </div>
      {groupForm && (
        <GroupForm
          links={choices}
          onCancel={() => setGroupForm(false)}
          onDone={() => {
            setGroupForm(false);
            void load();
          }}
        />
      )}
      <div data-testid="link-list">
        <section class="link-section" data-page="main">
          <h2>Main page</h2>
          {cards(links.filter((l) => l.page === "main"))}
        </section>
        {groups.map((g) => (
          <section class="link-section" data-page={g.slug} key={g.id}>
            <div class="actions">
              <h2>{g.title}</h2>
              <a href={bookUrl(g.slug)} data-testid="group-url">
                {bookUrl(g.slug)}
              </a>
              <button type="button" onClick={() => copy(bookUrl(g.slug))}>
                Copy group URL
              </button>
              <button type="button" onClick={() => setGroupAction({ id: g.id, kind: "edit" })}>
                Edit group
              </button>
              <button
                type="button"
                class="danger"
                onClick={() => setGroupAction({ id: g.id, kind: "delete" })}
              >
                Delete group
              </button>
            </div>
            {groupAction?.id === g.id && groupAction.kind === "edit" && (
              <GroupEditor
                group={g}
                links={choices}
                onCancel={() => setGroupAction(null)}
                onDone={() => {
                  setGroupAction(null);
                  void load();
                }}
              />
            )}
            {groupAction?.id === g.id && groupAction.kind === "delete" && (
              <GroupDelete
                group={g}
                groups={groups}
                onCancel={() => setGroupAction(null)}
                onDone={() => {
                  setGroupAction(null);
                  void load();
                }}
              />
            )}
            {cards(links.filter((l) => l.page === g.id))}
          </section>
        ))}
        <section class="link-section" data-page="hidden">
          <h2>Hidden</h2>
          <p class="status">No booking page lists these links; their direct URL works.</p>
          {cards(links.filter((l) => l.page === "hidden"))}
        </section>
      </div>
      <p class="status">Team admins manage webhook endpoints in Team settings.</p>
    </>
  ) : (
    <>
      <p>Choose the address of your booking page. People open it to book time with you.</p>
      <form
        class="form"
        data-testid="claim-form"
        onSubmit={(e) => {
          e.preventDefault();
          const slug = String(new FormData(e.currentTarget as HTMLFormElement).get("slug") ?? "");
          void act(() => api("POST", "/api/booking/page", { slug }));
        }}
      >
        <label>
          Page address
          <input name="slug" required pattern="[a-z0-9][a-z0-9-]*" placeholder="your-name" />
        </label>
        <button type="submit" class="primary">
          Create booking page
        </button>
      </form>
    </>
  );

  return (
    <div class="page" data-testid="links-page">
      <h1>Booking links</h1>
      <div class="actions">
        <button type="button" aria-pressed={tab === "mine"} onClick={() => setTab("mine")}>
          My links
        </button>
        <button
          type="button"
          aria-pressed={tab === "directory"}
          onClick={() => setTab("directory")}
        >
          Team booking pages
        </button>
      </div>
      {tab === "directory" ? (
        <BookingDirectory />
      ) : (
        <>
          {edited && (
            <LinkEditor
              key={edited.id}
              link={edited}
              groups={groups}
              people={people}
              isOwner={edited.owner.id === myId}
              onClose={() => setEditing(null)}
              onSaved={(title) => {
                setEditing(null);
                setSaved(title);
                void load();
              }}
            />
          )}
          {saved !== null && (
            <p class="status" data-testid="link-saved">
              Saved {saved}.
            </p>
          )}
          {error && <p class="error">{error}</p>}
          {mine}
          {teamLinks.length > 0 && (
            <section>
              <h2>Team links</h2>
              <p class="status">Links of teammates where you are an organizer or in the pool.</p>
              <div class="list" data-testid="team-links">
                {teamLinks.map((l) => (
                  <Fragment key={l.id}>
                    <div
                      class="row"
                      data-testid="team-link-row"
                      data-link-title={l.title}
                      data-link-id={l.id}
                    >
                      <div>
                        <div>{l.title}</div>
                        <div class="meta">
                          {LEVEL_NAMES[l.level]} · {l.durations.join(", ")} min · Owned by{" "}
                          {l.owner.name} ({l.owner.email})
                        </div>
                        {l.pageSlug && (
                          <div class="meta">
                            <a href={bookUrl(l.pageSlug, l.slug)}>{bookUrl(l.pageSlug, l.slug)}</a>
                          </div>
                        )}
                      </div>
                      <div class="actions">
                        {l.pageSlug && (
                          <button
                            type="button"
                            onClick={() => copy(bookUrl(l.pageSlug ?? "", l.slug))}
                          >
                            Copy link
                          </button>
                        )}
                        {editButton(l)}
                        {personalizeButton(l)}
                        {l.pageSlug && shareButton(l)}
                      </div>
                    </div>
                    {panels(l, bookUrl(l.pageSlug ?? "", l.slug))}
                  </Fragment>
                ))}
              </div>
            </section>
          )}
          {page && (
            <>
              <h2>Bookings</h2>
              <div class="list" data-testid="booking-list">
                {bookings.map((b) => (
                  <div class="row" key={b.id}>
                    <span>
                      {formatWhen(z, b.start_ms)} · {b.name} ({b.email}) ·{" "}
                      {b.link_title ?? "deleted link"}
                    </span>
                    <span class="badge">{b.status}</span>
                  </div>
                ))}
                {bookings.length === 0 && <p class="status">No bookings yet.</p>}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
