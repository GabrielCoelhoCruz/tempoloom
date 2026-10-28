// The consent page of an AI tool's OAuth sign-in (integrations-ai-tools.md
// "Authorization", edge case 2): it names the tool, where the answer goes, and
// the Tempoloom account it connects, and has "Allow access" and "Cancel". Both
// answers go back to the tool. A bad request stays on the page, with a link back.
import { useEffect, useState } from "preact/hooks";
import { utcToLocal } from "../../shared/time.ts";
import { ApiError, api } from "../lib/api.ts";
import { dateText } from "../lib/format.ts";
import { zone } from "../lib/state.ts";
import "./pages.css";

interface Request {
  client: string;
  email: string;
  /** Where the code goes: the redirect URI's host, or its scheme for an app. */
  host: string;
  registeredAt: number;
  unverified: boolean;
}

interface Refusal {
  error?: string;
  message?: string;
  host?: string;
  returnTo?: string;
}

const refusal = (err: unknown): Refusal =>
  (err instanceof ApiError && (err.body as Refusal | undefined)) || {};

const query = () => Object.fromEntries(new URLSearchParams(location.search));

export function OAuthConsent() {
  const [req, setReq] = useState<Request | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [back, setBack] = useState<{ host: string; url: string } | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    void api<Request>("GET", `/api/oauth/consent?${new URLSearchParams(query())}`)
      .then(setReq)
      .catch((err: unknown) => {
        const r = refusal(err);
        setError(r.error || "This sign-in request is not valid.");
        if (r.returnTo && r.host) setBack({ host: r.host, url: r.returnTo });
      });
  }, []);
  const answer = async (allow: boolean) => {
    setPending(true);
    try {
      const { redirect } = await api<{ redirect: string }>("POST", "/api/oauth/consent", {
        ...query(),
        allow,
      });
      location.assign(redirect);
    } catch (err) {
      setPending(false);
      setError(
        refusal(err).message || "That did not work. Start the connection in the AI tool again.",
      );
    }
  };
  return (
    <div class="login">
      <div class="card" data-testid="oauth-consent">
        <h1>Connect an AI tool</h1>
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        {back && (
          <p>
            <a href={back.url} data-testid="oauth-return">
              Return to {back.host}
            </a>
          </p>
        )}
        {req && (
          <>
            <p>
              <strong>{req.client}</strong> wants to connect to your Tempoloom account{" "}
              <strong>{req.email}</strong>.
            </p>
            <p class="status" data-testid="oauth-client-details">
              {req.unverified && (
                <>
                  <strong>Unverified:</strong> the app chose the name "{req.client}" itself.{" "}
                </>
              )}
              After your answer, Tempoloom sends you to <strong>{req.host}</strong>. The app was
              registered on {dateText(utcToLocal(zone(), req.registeredAt).date)}. Allow access only
              if you started this connection in that app.
            </p>
            <p class="status">
              It can read your schedule, tasks and stats, and stage changes in preview mode. Nothing
              changes on your calendar until you apply it. You can revoke its access on the Account
              page at any time.
            </p>
            <p class="status">
              Not your account?{" "}
              <button type="button" class="link" onClick={() => void signOut()}>
                Sign out
              </button>{" "}
              and sign in with the other one.
            </p>
            <div class="actions">
              <button
                type="button"
                class="primary"
                disabled={pending}
                onClick={() => void answer(true)}
              >
                Allow access
              </button>
              <button type="button" disabled={pending} onClick={() => void answer(false)}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Signs out and comes back to this page, which then shows the sign-in form. */
async function signOut() {
  await fetch("/auth/logout", { method: "POST", redirect: "manual" });
  location.reload();
}
