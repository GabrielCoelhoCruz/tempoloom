// Account page: added accounts (accounts-login-emails-permissions.md rules
// 6-8), delegated access (accounts-delegated-access.md rules 1-4, 10, 11),
// personal API keys (integrations-api-keys-zapier.md) and account deletion.
// During an acting session the owner's actions stay visible; the server
// refuses them with a message (delegated access rule 7).
import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { utcToLocal } from "../../shared/time.ts";
import { ApiError, api } from "../lib/api.ts";
import { toLocalInput } from "../lib/format.ts";
import { lazyComponent } from "../lib/lazy.ts";
import { useLive } from "../lib/live.ts";
import { loadMe, me, type Person, zone } from "../lib/state.ts";

const McpSection = lazyComponent(() => import("./mcp-section.tsx").then((m) => m.McpSection));

interface ApiKey {
  id: string;
  name: string;
  expires_at: number | null;
  last_used_at: number | null;
}
interface Change {
  actor: string;
  change: string;
  at: number;
}
interface Ask {
  title: string;
  text: string;
  action: string;
  onYes: () => void;
}

const reason = (err: unknown) =>
  (err instanceof ApiError && (err.body as { message?: string } | undefined)?.message) ||
  "That did not work. Try again.";

function Dialog({ ask, onClose }: { ask: Ask; onClose: () => void }) {
  return (
    <div class="dialog-backdrop">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <h2 id="dialog-title">{ask.title}</h2>
        <p>{ask.text}</p>
        <div class="actions">
          <button
            type="button"
            class="primary"
            onClick={() => {
              onClose();
              ask.onYes();
            }}
          >
            {ask.action}
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  id,
  children,
}: {
  title: string;
  id: string;
  children: ComponentChildren;
}) {
  return (
    <section data-testid={id}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function AccountPage() {
  const [message, setMessage] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Person[]>([]);
  const [delegates, setDelegates] = useState<Person[]>([]);
  const [changes, setChanges] = useState<Change[]>([]);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [newKey, setNewKey] = useState<{ name: string; secret: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [typed, setTyped] = useState("");
  const m = me.value;
  const acting = Boolean(m?.actor);
  const owner = m?.user.name ?? "";

  const load = useCallback(async () => {
    setKeys((await api<{ keys: ApiKey[] }>("GET", "/api/keys")).keys);
    if (acting) return;
    const d = await api<{ delegates: Person[]; changes: Change[] }>("GET", "/api/delegates");
    setDelegates(d.delegates);
    setChanges(d.changes);
  }, [acting]);
  useEffect(() => void load(), [load]);
  useLive(load);

  useEffect(() => {
    if (acting || !query.trim()) return setFound([]);
    void api<{ people: Person[] }>(
      "GET",
      `/api/delegates/search?q=${encodeURIComponent(query)}`,
    ).then((r) => setFound(r.people));
  }, [query, acting, delegates]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setMessage(null);
    try {
      await fn();
      await Promise.all([load(), loadMe()]);
      setMessage(done);
    } catch (err) {
      setMessage(reason(err));
    }
  };

  if (!m) return null;
  const when = (t: number) => toLocalInput(zone(), t).replace("T", " ");
  return (
    <div class="page" data-testid="account-page">
      <h1>Account</h1>
      {message && (
        <p class="status notice" role="status" data-testid="account-message">
          {message}
        </p>
      )}
      {ask && <Dialog ask={ask} onClose={() => setAsk(null)} />}

      <Section title="Calendar accounts" id="accounts">
        <div class="list" data-testid="account-list">
          {m.accounts.map((a) => (
            <div class="row" key={a.id} data-account={a.email}>
              <span>
                {a.email} <span class="meta">{a.provider}</span>{" "}
                {a.is_main === 1 && (
                  <span class="badge" data-testid="main-badge">
                    main
                  </span>
                )}{" "}
                <span class="badge">{a.status === "ok" ? "connected" : "disconnected"}</span>
              </span>
              <div class="actions">
                {a.is_main !== 1 && !a.viaGrant && (
                  <button
                    type="button"
                    onClick={() =>
                      acting
                        ? setMessage(
                            `Delegates cannot add or remove accounts or calendars. Ask ${owner} to do it.`,
                          )
                        : setAsk({
                            title: "Change main email",
                            text: `Use ${a.email} as your main email? Tempoloom then writes new events to its main calendar. You can still sign in with every email of this account.`,
                            action: "Use as main",
                            onYes: () =>
                              void act(
                                () => api("POST", `/api/accounts/${a.id}/main`),
                                `${a.email} is your main email.`,
                              ),
                          })
                    }
                  >
                    Use as main
                  </button>
                )}
                {a.is_main !== 1 && (
                  <button
                    type="button"
                    class="danger"
                    onClick={() =>
                      setAsk({
                        title: "Remove account",
                        text: `Remove ${a.email}? Tempoloom stops reading and writing its calendars and removes the coming events it placed there.`,
                        action: "Remove account",
                        onYes: () =>
                          void act(
                            () => api("DELETE", `/api/accounts/${a.id}`),
                            "Account removed.",
                          ),
                      })
                    }
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() =>
            acting
              ? setMessage(
                  `Delegates cannot add or remove accounts or calendars. Ask ${owner} to do it.`,
                )
              : setAdding(true)
          }
        >
          Add another account
        </button>
        {adding && !acting && (
          <form
            class="form"
            data-testid="add-account-form"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget as HTMLFormElement);
              void act(async () => {
                await api("POST", "/api/accounts", {
                  serverUrl: f.get("serverUrl"),
                  username: f.get("username"),
                  password: f.get("password"),
                  ...(f.get("email") ? { email: f.get("email") } : {}),
                });
                setAdding(false);
              }, "Account added.");
            }}
          >
            <label>
              CalDAV server URL
              <input name="serverUrl" type="url" required placeholder="https://dav.example.com/" />
            </label>
            <label>
              User name
              <input name="username" required autocomplete="off" />
            </label>
            <label>
              Password
              <input name="password" type="password" required autocomplete="new-password" />
            </label>
            <label>
              Email (if the user name is not an email)
              <input name="email" type="email" />
            </label>
            <div class="actions">
              <button type="submit" class="primary">
                Add account
              </button>
              <button type="button" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </Section>

      <Section title="Delegated access" id="delegates">
        {acting ? (
          <p class="status">Only {owner} can change delegated access.</p>
        ) : (
          <>
            <p class="status">
              A team member with access can switch into your account from their account menu and
              plan for you, for example an assistant.
            </p>
            <label>
              Search team members
              <input type="search" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
            </label>
            {query.trim() && (
              <div class="list" data-testid="candidates">
                {found.length === 0 && <p class="status">No team member matches.</p>}
                {found.map((p) => (
                  <div class="row" key={p.id} data-candidate={p.email}>
                    <span>
                      {p.name} <span class="meta">{p.email}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setAsk({
                          title: "Give access",
                          text: `${p.name} will see and change your Tempoloom data: tasks, habits, meetings, booking links and settings. They cannot delete your account, add or remove accounts or calendars, or manage API keys.`,
                          action: "Give access",
                          onYes: () =>
                            void act(
                              () => api("POST", "/api/delegates", { userId: p.id }),
                              `${p.name} has access.`,
                            ),
                        })
                      }
                    >
                      Give access
                    </button>
                  </div>
                ))}
              </div>
            )}
            <h3>People with access</h3>
            <div class="list" data-testid="delegate-list">
              {delegates.length === 0 && <p class="status">Nobody has delegated access.</p>}
              {delegates.map((p) => (
                <div class="row" key={p.id} data-delegate={p.email}>
                  <span>
                    {p.name} <span class="meta">{p.email}</span>
                  </span>
                  <button
                    type="button"
                    class="danger"
                    onClick={() =>
                      setAsk({
                        title: "Remove access",
                        text: `${p.name} loses access to your account at once.`,
                        action: "Remove access",
                        onYes: () =>
                          void act(
                            () => api("DELETE", `/api/delegates/${p.id}`),
                            `${p.name} no longer has access.`,
                          ),
                      })
                    }
                  >
                    Remove access
                  </button>
                </div>
              ))}
            </div>
            {changes.length > 0 && (
              <>
                <h3>Changes by people with access</h3>
                <ul class="meta" data-testid="delegate-changes">
                  {changes.map((c) => (
                    <li key={`${c.at}-${c.change}`}>
                      {c.actor} {c.change} · {when(c.at)}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </Section>

      <Section title="API keys" id="api-keys">
        <p class="status">
          A key lets another app, such as an automation service, act for you with the same rights.
        </p>
        <form
          class="form"
          data-testid="key-form"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget as HTMLFormElement;
            const f = new FormData(form);
            const name = String(f.get("name"));
            void act(async () => {
              const { secret } = await api<{ secret: string }>("POST", "/api/keys", {
                name,
                expires: f.get("expires"),
              });
              setNewKey({ name, secret });
              form.reset();
            }, "Key created.");
          }}
        >
          <label>
            Key name
            <input name="name" required maxLength={100} />
          </label>
          <label>
            Expires
            <select name="expires">
              <option value="30d">30 days</option>
              <option value="90d">90 days</option>
              <option value="1y">1 year</option>
              <option value="never" selected>
                Never
              </option>
            </select>
          </label>
          <button type="submit" class="primary">
            Generate
          </button>
        </form>
        {newKey && (
          <p class="status" data-testid="new-key">
            Copy the key "{newKey.name}" now. It will not show again: <code>{newKey.secret}</code>{" "}
            <button type="button" onClick={() => void navigator.clipboard.writeText(newKey.secret)}>
              Copy
            </button>
          </p>
        )}
        <div class="list" data-testid="key-list">
          {keys.map((k) => (
            <div class="row" key={k.id} data-key={k.name}>
              <span>
                {k.name}{" "}
                <span class="meta">
                  ·{" "}
                  {k.expires_at === null
                    ? "never expires"
                    : `expires ${utcToLocal(zone(), k.expires_at).date}`}{" "}
                  · {k.last_used_at === null ? "never used" : `last used ${when(k.last_used_at)}`}
                </span>
              </span>
              <div class="actions">
                <button
                  type="button"
                  onClick={() =>
                    void act(async () => {
                      const { secret } = await api<{ secret: string }>(
                        "POST",
                        `/api/keys/${k.id}/regenerate`,
                      );
                      setNewKey({ name: k.name, secret });
                    }, "Key regenerated. The old key no longer works.")
                  }
                >
                  Regenerate
                </button>
                <button
                  type="button"
                  class="danger"
                  onClick={() =>
                    setAsk({
                      title: "Delete key",
                      text: `Delete the key "${k.name}"? Apps that use it stop working.`,
                      action: "Delete key",
                      onYes: () =>
                        void act(() => api("DELETE", `/api/keys/${k.id}`), "Key deleted."),
                    })
                  }
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <McpSection />

      <Section title="Delete account" id="delete-account">
        {!deleting ? (
          <button type="button" class="danger" onClick={() => setDeleting(true)}>
            Delete my account
          </button>
        ) : (
          <form
            class="form"
            onSubmit={(e) => {
              e.preventDefault();
              setMessage(null);
              api("DELETE", "/api/me", { confirm: typed }).then(
                () => location.assign("/"),
                (err: unknown) => setMessage(reason(err)),
              );
            }}
          >
            <p class="wide">
              This deletes {m.user.email}'s Tempoloom account: tasks, habits, meetings, booking
              links, settings and the events Tempoloom placed from now on. Events you made stay.
            </p>
            <label>
              Type your email to confirm
              <input value={typed} onInput={(e) => setTyped(e.currentTarget.value)} />
            </label>
            <button
              type="submit"
              class="danger"
              disabled={typed.trim().toLowerCase() !== m.user.email}
            >
              Delete account permanently
            </button>
          </form>
        )}
      </Section>
    </div>
  );
}
