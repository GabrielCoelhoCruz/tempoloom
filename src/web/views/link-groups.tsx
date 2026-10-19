// Link groups on the links page: create, edit and delete a group
// (docs/specs/booking-links-sharing.md rules 1-6).
import { useState } from "preact/hooks";
import { ApiError, api } from "../lib/api.ts";

export interface Group {
  id: string;
  slug: string;
  title: string;
  branding: string;
}

interface LinkChoice {
  id: string;
  title: string;
  page: string;
}

const slugOf = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

const errorText = (err: unknown) => {
  const body =
    err instanceof ApiError
      ? (err.body as { error?: string; issues?: { message: string }[] } | undefined)
      : undefined;
  if (body?.error === "slug_taken") return "That URL name is taken. Choose another one.";
  return body?.issues?.[0]?.message ?? body?.error ?? String(err);
};

function LinkChecks({
  links,
  chosen,
  onChange,
}: {
  links: LinkChoice[];
  chosen: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <fieldset class="wide">
      <legend>Links on this page</legend>
      {links.map((l) => (
        <label class="inline" key={l.id}>
          <input
            type="checkbox"
            checked={chosen.includes(l.id)}
            onChange={(e) =>
              onChange(
                e.currentTarget.checked ? [...chosen, l.id] : chosen.filter((x) => x !== l.id),
              )
            }
          />
          {l.title}
        </label>
      ))}
    </fieldset>
  );
}

/** A new group: title, URL name (from the title until edited) and links (rule 1). */
export function GroupForm({
  links,
  onDone,
  onCancel,
}: {
  links: LinkChoice[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      class="form"
      data-testid="group-form"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        api("POST", "/api/booking/groups", {
          title,
          slug: slug ?? slugOf(title),
          linkIds: chosen,
        })
          .then(onDone)
          .catch((err) => setError(errorText(err)));
      }}
    >
      <h2 class="wide">New group</h2>
      <label>
        Title
        <input
          required
          maxLength={120}
          value={title}
          onInput={(e) => setTitle(e.currentTarget.value)}
        />
      </label>
      <label>
        URL name
        <input
          required
          pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
          value={slug ?? slugOf(title)}
          onInput={(e) => setSlug(e.currentTarget.value)}
        />
      </label>
      <LinkChecks links={links} chosen={chosen} onChange={setChosen} />
      {error && (
        <p class="error wide" role="alert">
          {error}
        </p>
      )}
      <div class="actions wide">
        <button type="submit" class="primary">
          Create group
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const BRANDINGS = [
  ["default", "Tempoloom logo"],
  ["none", "No logo"],
  ["custom", "Team logo and banner"],
] as const;

/** Edit a group's title, URL name, links and branding; warn before URLs break (rules 4, 5). */
export function GroupEditor({
  group,
  links,
  onDone,
  onCancel,
}: {
  group: Group;
  links: LinkChoice[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const before = links.filter((l) => l.page === group.id).map((l) => l.id);
  const [title, setTitle] = useState(group.title);
  const [slug, setSlug] = useState(group.slug);
  const [branding, setBranding] = useState(group.branding);
  const [chosen, setChosen] = useState<string[]>(before);
  const [error, setError] = useState<string | null>(null);
  const moved = chosen.length !== before.length || chosen.some((id) => !before.includes(id));
  return (
    <form
      class="form"
      data-testid="group-editor"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        api("PATCH", `/api/booking/groups/${group.id}`, {
          title,
          slug,
          branding,
          linkIds: chosen,
        })
          .then(onDone)
          .catch((err) => setError(errorText(err)));
      }}
    >
      <label>
        Title
        <input
          required
          maxLength={120}
          value={title}
          onInput={(e) => setTitle(e.currentTarget.value)}
        />
      </label>
      <label>
        URL name
        <input
          required
          pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
          value={slug}
          onInput={(e) => setSlug(e.currentTarget.value)}
        />
      </label>
      <label>
        Branding
        <select value={branding} onChange={(e) => setBranding(e.currentTarget.value)}>
          {BRANDINGS.map(([value, label]) => (
            <option value={value} key={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <LinkChecks links={links} chosen={chosen} onChange={setChosen} />
      {(slug !== group.slug || moved) && (
        <p class="error wide" data-testid="group-warning">
          Saving changes the URLs of this page or of the links you moved. URLs you shared before
          will stop working.
        </p>
      )}
      {error && (
        <p class="error wide" role="alert">
          {error}
        </p>
      )}
      <div class="actions wide">
        <button type="submit" class="primary">
          Save group
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Delete a group: move its links to another page, or delete them too (rule 6). */
export function GroupDelete({
  group,
  groups,
  onDone,
  onCancel,
}: {
  group: Group;
  groups: Group[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<"move" | "delete">("move");
  const [to, setTo] = useState("main");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      class="form"
      data-testid="group-delete"
      onSubmit={(e) => {
        e.preventDefault();
        const q = new URLSearchParams({ links: mode, ...(mode === "move" ? { to } : {}) });
        api("DELETE", `/api/booking/groups/${group.id}?${q}`)
          .then(onDone)
          .catch((err) => setError(errorText(err)));
      }}
    >
      <p class="wide">Delete the group "{group.title}"?</p>
      <div class="actions wide">
        <label class="inline">
          <input
            type="radio"
            name="mode"
            checked={mode === "move"}
            onChange={() => setMode("move")}
          />
          Move its links to
        </label>
        <select
          aria-label="Page for the links"
          value={to}
          disabled={mode !== "move"}
          onChange={(e) => setTo(e.currentTarget.value)}
        >
          <option value="main">Main page</option>
          <option value="hidden">Hidden</option>
          {groups
            .filter((g) => g.id !== group.id)
            .map((g) => (
              <option value={g.id} key={g.id}>
                {g.title}
              </option>
            ))}
        </select>
      </div>
      <label class="inline wide">
        <input
          type="radio"
          name="mode"
          checked={mode === "delete"}
          onChange={() => setMode("delete")}
        />
        Delete the group and its links
      </label>
      {error && (
        <p class="error wide" role="alert">
          {error}
        </p>
      )}
      <div class="actions wide">
        <button type="submit" class="danger">
          Delete group
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
