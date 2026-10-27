// Meeting checks (docs/specs/automations-meeting-quality.md): the built-in
// checks and their daily digest, and the company checks that team admins set.
import { useCallback, useEffect, useState } from "preact/hooks";
import type { CompanyCheck, CompanyConditions } from "../../server/meeting-checks.ts";
import type { CheckId, MeetingPrefs } from "../../server/meeting-prefs.ts";
import { CHECK_NAMES } from "../../shared/meeting-checks.ts";
import { api } from "../lib/api.ts";
import { templateFromUrl } from "../lib/library.ts";
import { useSave } from "../lib/save.ts";

interface ChecksData {
  prefs: MeetingPrefs;
  company: CompanyCheck[];
  admin: boolean;
  nextDigest: string | null;
}

function describe(c: CompanyConditions): string {
  const parts: string[] = [];
  if (c.minAttendees) parts.push(`${c.minAttendees} or more people`);
  if (c.descriptionEmpty) parts.push("no description");
  if (c.noVideoLink) parts.push("no video link");
  if (c.externalGuests) parts.push("guests from outside the team");
  if (c.longerThanMinutes) parts.push(`longer than ${c.longerThanMinutes} min`);
  if (c.titleContains) parts.push(`title contains "${c.titleContains}"`);
  return parts.join(", ");
}

export function MeetingChecks() {
  const [data, setData] = useState<ChecksData | null>(null);
  const checks = useSave();
  const company = useSave();
  const template = templateFromUrl();
  const preset = template?.kind === "meeting_check" ? template.preset : null;
  const [digest, setDigest] = useState<string | null>(null);

  const load = useCallback(async () => {
    setData(await api<ChecksData>("GET", "/api/meeting-checks"));
  }, []);
  useEffect(() => void load(), [load]);
  if (!data) return null;
  const { prefs } = data;
  const checked = (id: CheckId) => (preset?.checks.includes(id) ? true : prefs.checks[id]);

  return (
    <div class="page" data-testid="checks-page">
      <h1>Meeting checks</h1>
      <p>
        Tempoloom looks at your meetings in the next 7 days and flags problems in the planner's
        Issues tab. Checks never change a meeting.
      </p>
      <form
        class="form"
        data-testid="checks-form"
        key={template?.slug ?? "checks"}
        onInput={checks.reset}
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget as HTMLFormElement);
          const on = Object.fromEntries(
            (Object.keys(CHECK_NAMES) as CheckId[]).map((id) => [id, f.get(id) === "on"]),
          );
          void checks.save(async () => {
            await api("PATCH", "/api/meeting-prefs", {
              checks: on,
              digest: f.get("digest"),
              digestTime: f.get("digestTime"),
              ...(template
                ? { libraryEntries: [...new Set([...prefs.libraryEntries, template.slug])] }
                : {}),
            });
            await load();
          });
        }}
      >
        <fieldset class="wide">
          <legend>Checks</legend>
          {(Object.keys(CHECK_NAMES) as CheckId[]).map((id) => (
            <label class="inline" key={id}>
              <input type="checkbox" name={id} defaultChecked={checked(id)} />
              {CHECK_NAMES[id]}
            </label>
          ))}
        </fieldset>
        <label>
          Daily digest
          <select
            name="digest"
            value={digest ?? preset?.digest ?? prefs.digest}
            onChange={(e) => setDigest(e.currentTarget.value)}
          >
            <option value="email">Email</option>
            <option value="none">Off</option>
          </select>
        </label>
        <label>
          Digest time
          <input name="digestTime" type="time" required defaultValue={prefs.digestTime} />
        </label>
        <p class="meta wide">
          The digest lists the issues of the rest of this week and the first 2 workdays of next
          week. A chat app digest needs a chat integration, which Tempoloom does not have.
        </p>
        {typeof checks.state === "object" && (
          <p class="error wide" role="alert">
            {checks.state.error}
          </p>
        )}
        <div class="actions wide">
          <button type="submit" class="primary">
            Save checks
          </button>
          {checks.state === "saved" && (
            <span class="status" data-testid="checks-saved">
              Saved
            </span>
          )}
        </div>
      </form>
      <p class="status" data-testid="digest-status">
        {prefs.digest === "email" && data.nextDigest
          ? `Next digest: ${data.nextDigest}`
          : prefs.digest === "email"
            ? `Next digest: ${prefs.digestTime}`
            : "No digest"}
      </p>

      <section data-testid="company-checks">
        <h2>Company checks</h2>
        <p class="meta">
          Team admins set these for every member. Each one flags the meetings you organize.
        </p>
        <div class="list">
          {data.company.map((c) => (
            <div class="row" key={c.id} data-company-check={c.name}>
              <label class="inline">
                <input
                  type="checkbox"
                  checked={c.enabled}
                  disabled={!data.admin}
                  onChange={(e) =>
                    void api("PATCH", `/api/company-checks/${c.id}`, {
                      enabled: e.currentTarget.checked,
                    }).then(load)
                  }
                />
                <span
                  class="lock-icon"
                  role="img"
                  aria-label="Locked"
                  title="Set by your team admin"
                />{" "}
                {c.name}
              </label>
              <span class="meta">{describe(c.conditions)}</span>
              {data.admin && (
                <button
                  type="button"
                  class="danger"
                  onClick={() => void api("DELETE", `/api/company-checks/${c.id}`).then(load)}
                >
                  Delete
                </button>
              )}
            </div>
          ))}
          {data.company.length === 0 && <p class="status">No company checks.</p>}
        </div>
        {data.admin && (
          <form
            class="form"
            data-testid="company-check-form"
            onInput={company.reset}
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget as HTMLFormElement;
              const f = new FormData(form);
              const num = (k: string) => (f.get(k) ? Number(f.get(k)) : undefined);
              const text = String(f.get("titleContains") ?? "").trim();
              void company.save(async () => {
                await api("POST", "/api/company-checks", {
                  name: f.get("name"),
                  conditions: {
                    minAttendees: num("minAttendees"),
                    descriptionEmpty: f.get("descriptionEmpty") === "on",
                    noVideoLink: f.get("noVideoLink") === "on",
                    externalGuests: f.get("externalGuests") === "on",
                    longerThanMinutes: num("longerThan"),
                    ...(text ? { titleContains: text } : {}),
                  },
                });
                form.reset();
                await load();
              });
            }}
          >
            <label class="wide">
              Name
              <input name="name" required maxLength={100} />
            </label>
            <label>
              At least this many attendees
              <input name="minAttendees" type="number" min={2} max={500} />
            </label>
            <label>
              Longer than (minutes)
              <input name="longerThan" type="number" min={5} max={1440} />
            </label>
            <label>
              Title contains
              <input name="titleContains" maxLength={100} />
            </label>
            <label class="inline">
              <input type="checkbox" name="descriptionEmpty" />
              Description is empty
            </label>
            <label class="inline">
              <input type="checkbox" name="noVideoLink" />
              No video link
            </label>
            <label class="inline">
              <input type="checkbox" name="externalGuests" />
              Guests from outside the team
            </label>
            {typeof company.state === "object" && (
              <p class="error wide" role="alert">
                {company.state.error}
              </p>
            )}
            <div class="actions wide">
              <button type="submit">Add company check</button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
