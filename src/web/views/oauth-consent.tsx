// The consent page of an AI tool's OAuth sign-in (integrations-ai-tools.md
// "Authorization", edge case 2): it names the tool and the Tempoloom account it
// connects, and has "Allow access" and "Cancel". Both answers go back to the tool.
import { useEffect, useState } from "preact/hooks";
import { ApiError, api } from "../lib/api.ts";

interface Request {
  client: string;
  email: string;
}

const query = () => Object.fromEntries(new URLSearchParams(location.search));

export function OAuthConsent() {
  const [req, setReq] = useState<Request | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    void api<Request | { redirect: string }>(
      "GET",
      `/api/oauth/consent?${new URLSearchParams(query())}`,
    )
      .then((r) => ("redirect" in r ? location.assign(r.redirect) : setReq(r)))
      .catch((err: unknown) =>
        setError(
          (err instanceof ApiError && (err.body as { error?: string } | undefined)?.error) ||
            "This sign-in request is not valid.",
        ),
      );
  }, []);
  const answer = async (allow: boolean) => {
    setPending(true);
    try {
      const { redirect } = await api<{ redirect: string }>("POST", "/api/oauth/consent", {
        ...query(),
        allow,
      });
      location.assign(redirect);
    } catch {
      setPending(false);
      setError("That did not work. Start the connection in the AI tool again.");
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
        {req && (
          <>
            <p>
              <strong>{req.client}</strong> wants to connect to your Tempoloom account{" "}
              <strong>{req.email}</strong>.
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
