// Team admin settings for organizations (docs/specs/admin-sso-provisioning.md):
// single sign-on, calendar access for every member, and paced imports of people.
// Part of the Team page chunk.
import { useEffect, useState } from "preact/hooks";
import { ApiError, api } from "../lib/api.ts";

const codeOf = (err: unknown) =>
  err instanceof ApiError
    ? (err.body as { error?: string; domain?: string } | undefined)
    : undefined;

interface SsoSetup {
  domains: string[];
  issuer: string;
  clientId: string;
  hasSecret: boolean;
  mode: "sso_only" | "sso_and_google";
  domainCapture: boolean;
  redirectUri: string;
}

function ssoError(err: unknown): string {
  const body = codeOf(err);
  switch (body?.error) {
    case "domain_taken":
      return `${body.domain} already uses single sign-on with another team.`;
    case "public_domain":
      return `${body.domain} is a public email domain; register your company's own domain.`;
    case "invalid_domain":
      return `"${body.domain}" is not an email domain.`;
    case "secret_required":
      return "Enter the client secret.";
    case "bad_discovery":
      return "The issuer URL does not match the identity provider's discovery document.";
    case "provider_unreachable":
      return "Could not read the identity provider's discovery document at this issuer URL.";
    default:
      return body?.error ?? String(err);
  }
}

/** The team's OpenID Connect identity provider (rules 2-5, 9). */
export function SsoSettings() {
  const [setup, setSetup] = useState<SsoSetup | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => setSetup(await api<SsoSetup>("GET", "/api/team/sso"));
  useEffect(() => void load(), []);
  if (!setup) return null;
  const on = setup.hasSecret;
  return (
    <section data-testid="sso">
      <h2>Single sign-on (SSO)</h2>
      <p class="status">
        People on these email domains sign in through your identity provider (OpenID Connect).
        Register this redirect URI with it:{" "}
        <code data-testid="sso-redirect-uri">{setup.redirectUri}</code>
      </p>
      <form
        class="form"
        key={JSON.stringify(setup)}
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget as HTMLFormElement);
          setSaved(false);
          setError(null);
          try {
            await api("PUT", "/api/team/sso", {
              domains: String(f.get("domains") ?? "")
                .split(/[\s,;]+/)
                .filter(Boolean),
              issuer: String(f.get("issuer") ?? ""),
              clientId: String(f.get("clientId") ?? ""),
              clientSecret: String(f.get("clientSecret") ?? ""),
              mode: String(f.get("mode")),
              domainCapture: f.get("domainCapture") === "on",
            });
            await load();
            setSaved(true);
          } catch (err) {
            setError(ssoError(err));
          }
        }}
      >
        <label class="wide">
          Email domains (comma separated)
          <input name="domains" defaultValue={setup.domains.join(", ")} required />
        </label>
        <label>
          Issuer URL
          <input name="issuer" type="url" defaultValue={setup.issuer} required />
        </label>
        <label>
          Client ID
          <input name="clientId" defaultValue={setup.clientId} required />
        </label>
        <label>
          Client secret
          <input
            name="clientSecret"
            type="password"
            autocomplete="off"
            required={!on}
            placeholder={on ? "Leave empty to keep the saved secret" : ""}
          />
        </label>
        <label>
          Sign-in mode
          <select name="mode" value={setup.mode}>
            <option value="sso_only">SSO only</option>
            <option value="sso_and_google">SSO and other sign-in</option>
          </select>
        </label>
        <label class="inline wide">
          <input type="checkbox" name="domainCapture" defaultChecked={setup.domainCapture} />
          Domain capture: new sign-ups on these domains join this team
        </label>
        {on && (
          <span class="status wide" data-testid="sso-secret-state">
            A client secret is saved.
          </span>
        )}
        <button type="submit" class="primary">
          Save single sign-on
        </button>
        {on && (
          <button
            type="button"
            class="danger"
            onClick={async () => {
              await api("DELETE", "/api/team/sso");
              setSaved(false);
              await load();
            }}
          >
            Turn off single sign-on
          </button>
        )}
        {saved && (
          <span class="status" data-testid="sso-saved">
            Saved.
          </span>
        )}
        {error && (
          <p class="error wide" role="alert">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}

interface GrantSetup {
  serverUrl: string;
  username: string;
  hasPassword: boolean;
  homeTemplate: string;
}

/** A CalDAV account that reads every member's calendars (rules 12-15). */
export function CalendarAccess() {
  const [grant, setGrant] = useState<GrantSetup | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => setGrant(await api<GrantSetup>("GET", "/api/team/grant"));
  useEffect(() => void load(), []);
  if (!grant) return null;
  return (
    <section data-testid="calendar-grant">
      <h2>Calendar access for the organization (CalDAV)</h2>
      <p class="status">
        A CalDAV account that can read every member's calendars. Tempoloom attaches each provisioned
        person's calendar read-only and reads it once a day until their first sign-in.
      </p>
      <form
        class="form"
        key={JSON.stringify(grant)}
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget as HTMLFormElement);
          setSaved(false);
          setError(null);
          try {
            await api("PUT", "/api/team/grant", {
              serverUrl: String(f.get("serverUrl") ?? ""),
              username: String(f.get("username") ?? ""),
              password: String(f.get("password") ?? ""),
              homeTemplate: String(f.get("homeTemplate") ?? ""),
            });
            await load();
            setSaved(true);
          } catch (err) {
            const code = codeOf(err)?.error;
            setError(
              code === "invalid_credentials"
                ? "The server rejected the user name or password."
                : code === "password_required"
                  ? "Enter the password."
                  : "Could not reach the CalDAV server.",
            );
          }
        }}
      >
        <label>
          CalDAV server URL
          <input name="serverUrl" type="url" defaultValue={grant.serverUrl} required />
        </label>
        <label>
          User name
          <input name="username" defaultValue={grant.username} required autocomplete="off" />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            autocomplete="off"
            required={!grant.hasPassword}
            placeholder={grant.hasPassword ? "Leave empty to keep the saved password" : ""}
          />
        </label>
        <label>
          Calendar home of each person
          <input name="homeTemplate" defaultValue={grant.homeTemplate} required />
        </label>
        <p class="status wide">
          The home is relative to the server URL. {"{local}"} is the part of the email before the @,{" "}
          {"{email}"} the whole email.
        </p>
        {grant.hasPassword && (
          <span class="status wide" data-testid="grant-state">
            A password is saved.
          </span>
        )}
        <button type="submit" class="primary">
          Save calendar access
        </button>
        {grant.hasPassword && (
          <button
            type="button"
            class="danger"
            onClick={async () => {
              await api("DELETE", "/api/team/grant");
              setSaved(false);
              await load();
            }}
          >
            Remove calendar access
          </button>
        )}
        {saved && (
          <span class="status" data-testid="grant-saved">
            Saved.
          </span>
        )}
        {error && (
          <p class="error wide" role="alert">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}

/** Parses "email,name,attribute..." lines; the first line names the columns. */
function parseCsv(text: string) {
  const [head = "", ...lines] = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const cols = head.split(",").map((c) => c.trim());
  const emailAt = cols.findIndex((c) => c.toLowerCase() === "email");
  const nameAt = cols.findIndex((c) => c.toLowerCase() === "name");
  if (emailAt < 0) return null;
  return lines.map((line) => {
    const cells = line.split(",").map((c) => c.trim());
    const attributes: Record<string, string> = {};
    for (const [i, c] of cols.entries()) {
      const v = cells[i];
      if (i !== emailAt && i !== nameAt && c && v) attributes[c] = v;
    }
    return {
      email: cells[emailAt] ?? "",
      ...(nameAt >= 0 && cells[nameAt] ? { name: cells[nameAt] } : {}),
      attributes,
    };
  });
}

interface Progress {
  total: number;
  done: number;
  failed: number;
  errors: { email: string; error: string }[];
}

/** Adds many people at once through the admin provisioning API (rules 10, 18). */
export function ProvisionImport() {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const load = async () => setProgress(await api<Progress>("GET", "/api/team/provisioning"));
  useEffect(() => void load(), []);
  return (
    <section data-testid="provision-import">
      <h2>Add people</h2>
      <p class="status">
        Tempoloom adds them one at a time, so a large list takes a while. They do not use a seat
        until they sign in.
      </p>
      <form
        class="form"
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget as HTMLFormElement);
          const people = parseCsv(String(f.get("people") ?? ""));
          if (!people?.length) {
            setResult('The first line must name the columns, with an "email" column.');
            return;
          }
          try {
            const res = await api<{ queued: number }>("POST", "/api/team/provisioning", {
              people,
            });
            setResult(`${res.queued} ${res.queued === 1 ? "person" : "people"} queued.`);
            await load();
          } catch (err) {
            setResult(codeOf(err)?.error === "invalid_body" ? "Check the emails." : String(err));
          }
        }}
      >
        <label class="wide">
          People to add (CSV: a header line, then email, name and attribute columns)
          <textarea name="people" rows={5} required placeholder={"email,name,department"} />
        </label>
        <button type="submit" class="primary">
          Add people
        </button>
        {result && (
          <span class="status" data-testid="import-result">
            {result}
          </span>
        )}
      </form>
      {progress && progress.total > 0 && (
        <p class="status">
          <span data-testid="provision-progress">
            {progress.done} of {progress.total} people added
          </span>
          {progress.failed > 0 &&
            `; ${progress.failed} failed: ${progress.errors.map((e) => `${e.email} (${e.error})`).join(", ")}`}
        </p>
      )}
    </section>
  );
}
