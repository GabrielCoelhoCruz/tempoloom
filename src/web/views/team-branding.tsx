// Team settings > Booking page branding, for admins (docs/specs/
// booking-links-booking-page.md rules 25-31): logo, banner, homepage and the
// default that new booking pages copy.
import { useCallback, useEffect, useState } from "preact/hooks";
import { ApiError, api } from "../lib/api.ts";
import "./pages.css";

interface TeamBranding {
  mode: "default" | "none" | "custom";
  homepageUrl: string;
  logo: string | null;
  banner: string | null;
}

const MODES = [
  ["default", "Tempoloom logo"],
  ["none", "No logo"],
  ["custom", "Team logo and banner"],
] as const;

export function TeamBranding() {
  const [b, setB] = useState<TeamBranding | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const load = useCallback(async () => {
    setB(await api<TeamBranding>("GET", "/api/team/branding"));
  }, []);
  useEffect(() => void load(), [load]);

  const upload = async (kind: "logo" | "banner", input: HTMLInputElement) => {
    const file = input.files?.[0];
    if (!file) return;
    setError(null);
    const body = new FormData();
    body.set("file", file);
    const res = await fetch(`/api/team/branding/${kind}`, { method: "POST", body });
    input.value = "";
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      setError(data.message ?? "The upload failed.");
      return;
    }
    await load();
  };

  if (!b) return null;
  return (
    <section data-testid="team-branding">
      <h2>Booking page branding</h2>
      <p class="status">
        Booking pages show the Tempoloom logo, no logo, or the team's logo and banner. A new booking
        page starts with the default below; each page and link can change it.
      </p>
      <form
        class="form"
        key={`${b.mode}-${b.homepageUrl}`}
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget as HTMLFormElement);
          setError(null);
          setSaved(false);
          api("PUT", "/api/team/branding", {
            mode: String(f.get("mode")),
            homepageUrl: String(f.get("homepageUrl") ?? "").trim(),
          })
            .then(() => {
              setSaved(true);
              return load();
            })
            .catch((err) => {
              const body =
                err instanceof ApiError
                  ? (err.body as { issues?: { message: string }[] } | undefined)
                  : undefined;
              setError(body?.issues?.[0]?.message ?? String(err));
            });
        }}
      >
        <label>
          Default for new booking pages
          <select name="mode">
            {MODES.map(([value, label]) => (
              <option value={value} key={value} selected={value === b.mode}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label class="wide">
          Homepage URL
          <input name="homepageUrl" type="url" defaultValue={b.homepageUrl} />
        </label>
        <button type="submit" class="primary">
          Save branding
        </button>
        {saved && (
          <span class="status" data-testid="branding-saved">
            Saved
          </span>
        )}
      </form>
      <div class="form">
        <label>
          Logo (JPG or PNG, up to 2 MB)
          <input
            type="file"
            accept="image/png,image/jpeg"
            onChange={(e) => void upload("logo", e.currentTarget)}
          />
        </label>
        {b.logo && (
          <img src={b.logo} alt="Team logo" class="brand-logo" data-testid="logo-preview" />
        )}
        <label>
          Banner (JPG or PNG, up to 8 MB, shown at 1200 x 400)
          <input
            type="file"
            accept="image/png,image/jpeg"
            onChange={(e) => void upload("banner", e.currentTarget)}
          />
        </label>
        {b.banner && (
          <img src={b.banner} alt="Team banner" class="brand-banner" data-testid="banner-preview" />
        )}
      </div>
      {error && (
        <p class="error" data-testid="branding-error">
          {error}
        </p>
      )}
    </section>
  );
}
