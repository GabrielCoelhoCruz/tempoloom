import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { ApiError, api } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { me } from "../lib/state.ts";

interface Member {
  userId: string;
  name: string;
  email: string;
  role: "admin" | "member";
}

export interface TeamInfo {
  team: { id: string; name: string; joinMode: string; invitePermission: string };
  role: "admin" | "member";
  members: Member[];
  invites: { id: string; email: string; canManage: boolean }[];
  requests: { userId: string; name: string; email: string }[];
  seats: { used: number; limit: number | null };
  overage: boolean;
  canInvite: boolean;
  mailConfigured: boolean;
  prompts: {
    colleagues: { email: string; name: string }[];
    teams: { id: string; name: string; joinMode: string; requested: boolean }[];
  };
}

const MESSAGES: Record<string, string> = {
  no_seats: "The team has no free seats.",
  invalid_invite: "This invitation is no longer valid.",
  request_resolved: "Another admin already answered this request.",
  forbidden: "Only a team admin can do this.",
};

export function errorText(err: unknown, context?: "leave" | "role"): string {
  const body = err instanceof ApiError ? (err.body as { error?: string } | undefined) : undefined;
  const code = body?.error ?? "";
  if (code === "sole_admin") {
    return context === "role"
      ? "Make another member an admin before you remove your admin role."
      : "Make another member an admin before you leave.";
  }
  return MESSAGES[code] ?? (code || String(err));
}

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

function InviteForm({ isAdmin, onSent }: { isAdmin: boolean; onSent: (msg: string) => void }) {
  return (
    <form
      class="form"
      data-testid="invite-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget as HTMLFormElement);
        const emails = String(f.get("emails") ?? "")
          .split(/[\s,;]+/)
          .map((x) => x.trim())
          .filter(Boolean);
        try {
          const res = await api<{
            sent: string[];
            created: string[];
            unsent: string[];
            refused: { email: string }[];
          }>("POST", "/api/team/invites", {
            emails,
            message: String(f.get("message") ?? ""),
            admin: f.get("admin") === "on",
          });
          const parts: string[] = [];
          if (res.sent.length) parts.push(`Invitations sent to ${people(res.sent.length)}.`);
          else if (res.created.length && !res.unsent.length)
            parts.push(
              `Invited ${people(res.created.length)}. Email is not set up on this server: copy each invite link from the table.`,
            );
          if (res.unsent.length) parts.push(`Could not send email to ${res.unsent.join(", ")}.`);
          for (const r of res.refused) parts.push(`${r.email} is already a member.`);
          onSent(parts.join(" "));
        } catch (err) {
          onSent(errorText(err));
        }
      }}
    >
      <label class="wide">
        Emails (comma or line separated)
        <textarea name="emails" rows={2} required />
      </label>
      <label class="wide">
        Message (optional)
        <textarea name="message" rows={2} />
      </label>
      {isAdmin && (
        <label class="inline">
          <input type="checkbox" name="admin" />
          Make admin
        </label>
      )}
      <button type="submit" class="primary">
        Send invitations
      </button>
    </form>
  );
}

function Confirm({
  text,
  action,
  onYes,
  onNo,
}: {
  text: string;
  action: string;
  onYes: () => void;
  onNo: () => void;
}) {
  return (
    <div class="confirm">
      <span>{text}</span>
      <button type="button" class="danger" onClick={onYes}>
        {action}
      </button>
      <button type="button" onClick={onNo}>
        Cancel
      </button>
    </div>
  );
}

function TeamSettingsForm({ info, onSaved }: { info: TeamInfo; onSaved: () => void }) {
  const [saved, setSaved] = useState(false);
  return (
    <form
      class="form"
      data-testid="team-settings"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget as HTMLFormElement);
        await api("PATCH", "/api/team", {
          name: String(f.get("name") ?? ""),
          joinMode: String(f.get("joinMode")),
          invitePermission: String(f.get("invitePermission")),
        });
        setSaved(true);
        onSaved();
      }}
    >
      <label>
        Team name
        <input name="name" defaultValue={info.team.name} required />
      </label>
      <label>
        How people join
        <select name="joinMode" value={info.team.joinMode}>
          <option value="invite_only">Invite only</option>
          <option value="request">Ask to join (an admin approves)</option>
          <option value="automatic">Join automatically</option>
        </select>
      </label>
      <label>
        Who can invite
        <select name="invitePermission" value={info.team.invitePermission}>
          <option value="admins">Admins only</option>
          <option value="all_members">All members</option>
        </select>
      </label>
      <button type="submit" class="primary">
        Save team settings
      </button>
      {saved && (
        <span class="status" data-testid="team-settings-saved">
          Saved.
        </span>
      )}
    </form>
  );
}

export function TeamPage({ children }: { children?: ComponentChildren }) {
  const [info, setInfo] = useState<TeamInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: "leave" | "remove"; userId: string } | null>(null);
  const [review, setReview] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setInfo(await api<TeamInfo>("GET", "/api/team"));
  }, []);
  useEffect(() => void load(), [load]);

  const act = async (fn: () => Promise<unknown>, context?: "leave" | "role") => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(errorText(err, context));
    }
  };

  if (!info) return null;
  const myId = me.value?.user.id;
  const isAdmin = info.role === "admin";
  const alone = info.members.length === 1;
  const { used, limit } = info.seats;
  return (
    <div class="page" data-testid="team-page">
      <h1 data-testid="team-name">{info.team.name}</h1>
      {limit !== null && (
        <p class="status" data-testid="seat-bar">
          {used} of {limit} seats used, {Math.max(0, limit - used)} left
        </p>
      )}
      {info.overage && (
        <p class="error" data-testid="overage">
          This team has more members than seats. Scheduling goes on for everyone; new members cannot
          join until seats are free.
        </p>
      )}
      <div data-testid="team-prompts">
        {info.prompts.colleagues.length > 0 && info.canInvite && (
          <form
            class="form"
            data-testid="colleagues-prompt"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget as HTMLFormElement);
              const emails = f.getAll("colleague").map(String);
              if (!emails.length) return;
              try {
                const res = await api<{ sent: string[] }>("POST", "/api/team/invites", { emails });
                setResult(`Invitations sent to ${people(res.sent.length)}.`);
                await load();
              } catch (err) {
                setResult(errorText(err));
              }
            }}
          >
            <p class="wide">People from your company use Tempoloom. Create a team with them:</p>
            {info.prompts.colleagues.map((p) => (
              <label class="inline" key={p.email}>
                <input type="checkbox" name="colleague" value={p.email} />
                {p.email}
              </label>
            ))}
            <button type="submit" class="primary">
              Invite selected
            </button>
          </form>
        )}
        {info.prompts.teams.map((t) => (
          <div class="row" data-testid="join-prompt" key={t.id}>
            <div>
              <div>{t.name}</div>
              <div class="meta">A team at your company.</div>
            </div>
            {t.requested ? (
              <span class="status">Request sent</span>
            ) : t.joinMode === "automatic" ? (
              <button
                type="button"
                class="primary"
                onClick={() => void act(() => api("POST", "/api/team/join", { teamId: t.id }))}
              >
                Join
              </button>
            ) : (
              <button
                type="button"
                class="primary"
                onClick={() => void act(() => api("POST", "/api/team/requests", { teamId: t.id }))}
              >
                Request to join
              </button>
            )}
          </div>
        ))}
      </div>

      <div class="toolbar-inline">
        <h2>Members</h2>
        {info.canInvite && (
          <button type="button" onClick={() => setInviting(!inviting)}>
            {alone ? "Add member" : "Invite"}
          </button>
        )}
      </div>
      {inviting && (
        <InviteForm
          isAdmin={isAdmin}
          onSent={(msg) => {
            setResult(msg);
            void load();
          }}
        />
      )}
      {result && (
        <p class="status" data-testid="invite-result">
          {result}
        </p>
      )}
      {copied && (
        <p class="status">
          Link copied: <code data-testid="copied-link">{copied}</code>
        </p>
      )}
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <div class="list" data-testid="member-table">
        {info.members.map((m) => (
          <div class="row" key={m.userId} data-member={m.email}>
            <div>
              <div>
                {m.name} <span class="meta">{m.email}</span>
              </div>
              <div class="meta">
                <span class="badge" data-testid="role">
                  {m.role}
                </span>{" "}
                <span class="badge" data-testid="status">
                  active
                </span>
              </div>
              {confirm?.userId === m.userId && confirm.kind === "leave" && (
                <Confirm
                  text={`Leave ${info.team.name}? Your tasks, habits and events stay.`}
                  action="Leave"
                  onNo={() => setConfirm(null)}
                  onYes={() => {
                    setConfirm(null);
                    void act(() => api("POST", "/api/team/leave"), "leave");
                  }}
                />
              )}
              {confirm?.userId === m.userId && confirm.kind === "remove" && (
                <Confirm
                  text={`Remove ${m.email} from the team?`}
                  action="Remove"
                  onNo={() => setConfirm(null)}
                  onYes={() => {
                    setConfirm(null);
                    void act(() => api("DELETE", `/api/team/members/${m.userId}`));
                  }}
                />
              )}
            </div>
            <div class="actions">
              {isAdmin && (
                <button
                  type="button"
                  onClick={() =>
                    void act(
                      () =>
                        api("PATCH", `/api/team/members/${m.userId}`, {
                          role: m.role === "admin" ? "member" : "admin",
                        }),
                      "role",
                    )
                  }
                >
                  {m.role === "admin" ? "Remove admin" : "Make admin"}
                </button>
              )}
              {m.userId === myId && !alone && (
                <button
                  type="button"
                  class="danger"
                  onClick={() => setConfirm({ kind: "leave", userId: m.userId })}
                >
                  Leave team
                </button>
              )}
              {isAdmin && m.userId !== myId && (
                <button
                  type="button"
                  class="danger"
                  onClick={() => setConfirm({ kind: "remove", userId: m.userId })}
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        ))}
        {info.invites.map((i) => (
          <div class="row" key={i.id} data-member={i.email}>
            <div>
              <div>{i.email}</div>
              <div class="meta">
                <span class="badge" data-testid="status">
                  invited
                </span>
              </div>
            </div>
            {i.canManage && (
              <div class="actions">
                <button
                  type="button"
                  onClick={async () => {
                    const { url } = await api<{ url: string }>(
                      "POST",
                      `/api/team/invites/${i.id}/link`,
                    );
                    await navigator.clipboard?.writeText(url).catch(() => {});
                    setCopied(url);
                  }}
                >
                  Copy invite link
                </button>
                <button
                  type="button"
                  class="danger"
                  onClick={() => void act(() => api("DELETE", `/api/team/invites/${i.id}`))}
                >
                  Revoke invitation
                </button>
              </div>
            )}
          </div>
        ))}
        {info.requests.map((q) => (
          <div class="row" key={q.userId} data-member={q.email}>
            <div>
              <div>
                {q.name} <span class="meta">{q.email}</span>
              </div>
              <div class="meta">
                <span class="badge" data-testid="status">
                  requested
                </span>
              </div>
              {review === q.userId && (
                <form class="confirm" data-testid="review" onSubmit={(e) => e.preventDefault()}>
                  <span>
                    {q.name} ({q.email}) asks to join.
                  </span>
                  <label class="inline">
                    <input type="checkbox" name="admin" />
                    Make admin
                  </label>
                  <button
                    type="button"
                    class="primary"
                    onClick={(e) => {
                      const form = (e.currentTarget as HTMLButtonElement).form;
                      const asAdmin = form ? new FormData(form).get("admin") === "on" : false;
                      setReview(null);
                      void act(() =>
                        api("POST", `/api/team/requests/${q.userId}/approve`, { admin: asAdmin }),
                      );
                    }}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    class="danger"
                    onClick={() => {
                      setReview(null);
                      void act(() => api("POST", `/api/team/requests/${q.userId}/reject`));
                    }}
                  >
                    Reject
                  </button>
                </form>
              )}
            </div>
            <div class="actions">
              <button type="button" onClick={() => setReview(q.userId)}>
                Review
              </button>
            </div>
          </div>
        ))}
      </div>

      {isAdmin && (
        <>
          <h2>Team settings</h2>
          <TeamSettingsForm info={info} onSaved={() => void load()} />
          <Directory />
        </>
      )}
      {children}
    </div>
  );
}

interface DirectoryPerson {
  email: string;
  name: string;
  attributes: Record<string, string>;
  signedIn: boolean;
  seat: boolean;
  calendar: boolean;
  deactivated: boolean;
}

/** Directory provisioning: the SCIM token and the people the directory sent. */
function Directory() {
  const [dir, setDir] = useState<{ hasToken: boolean; people: DirectoryPerson[] } | null>(null);
  const [created, setCreated] = useState<{ token: string; baseUrl: string } | null>(null);
  useEffect(() => {
    void api<typeof dir>("GET", "/api/team/directory").then(setDir);
  }, []);
  if (!dir) return null;
  return (
    <section data-testid="directory">
      <div class="toolbar-inline">
        <h2>Directory provisioning (SCIM)</h2>
        <button
          type="button"
          onClick={async () => {
            setCreated(await api("POST", "/api/team/scim-token"));
          }}
        >
          {dir.hasToken || created ? "Replace SCIM token" : "Create SCIM token"}
        </button>
      </div>
      {created && (
        <p class="status">
          SCIM base URL: <code data-testid="scim-base-url">{created.baseUrl}</code>
          <br />
          Token (shown once; a new token replaces it):{" "}
          <code data-testid="scim-token">{created.token}</code>
        </p>
      )}
      <div class="list">
        {dir.people.map((p) => (
          <div class="row" key={p.email} data-directory={p.email}>
            <div>
              <div>
                {p.name} <span class="meta">{p.email}</span>
              </div>
              <div class="meta">
                {Object.entries(p.attributes).map(([k, v]) => (
                  <span class="badge" key={k}>
                    {k}: {v}
                  </span>
                ))}
              </div>
            </div>
            <div class="meta">
              {p.deactivated ? "deactivated · " : ""}signed in: {p.signedIn ? "yes" : "no"} · seat:{" "}
              {p.seat ? "used" : "none"} · calendar: {p.calendar ? "attached" : "none"}
            </div>
          </div>
        ))}
        {dir.people.length === 0 && <p class="status">The directory has sent nobody yet.</p>}
      </div>
    </section>
  );
}

/** The page behind an invitation link. Signed out, it shows the sign-in form first. */
export function JoinPage({ token, login }: { token: string; login?: ComponentChildren }) {
  const [invite, setInvite] = useState<
    { valid: false } | { valid: true; team: string; inviter: string | null } | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api<typeof invite>("GET", `/pub/invites/${token}`).then(setInvite);
  }, [token]);
  if (!invite) return null;
  return (
    <div class={login ? "login" : "page"}>
      <div class={login ? "card" : ""} data-testid="join-page">
        <h1>Join a team</h1>
        {invite.valid ? (
          <>
            <p>
              {invite.inviter ?? "Someone"} invited you to join {invite.team}.
            </p>
            {login ? (
              <>
                <p>Sign in to join.</p>
                {login}
              </>
            ) : (
              <button
                type="button"
                class="primary"
                onClick={async () => {
                  setError(null);
                  try {
                    await api("POST", "/api/team/invites/accept", { token });
                    navigate("/team");
                  } catch (err) {
                    setError(errorText(err));
                  }
                }}
              >
                Join team
              </button>
            )}
          </>
        ) : (
          <p>This invitation is no longer valid.</p>
        )}
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
