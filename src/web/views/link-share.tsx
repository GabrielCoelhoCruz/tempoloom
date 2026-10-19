// The share action of a link card: copy URL, email, social networks and
// website embeds (docs/specs/booking-links-sharing.md rules 23-26). Loaded on
// first use.
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.ts";

type Format = "script" | "object" | "iframe" | "url";
type Redirect = "disabled" | "topPage" | "frame";

const FORMATS: [Format, string][] = [
  ["script", "Script"],
  ["object", "Object"],
  ["iframe", "iframe"],
  ["url", "URL"],
];
const REDIRECTS: [Redirect, string][] = [
  ["disabled", "Stay in the embed (no redirect)"],
  ["topPage", "The whole page goes to the redirect URL"],
  ["frame", "Only the frame goes to the redirect URL"],
];

/** Proposed share message of booking-links.md (`shareMessage`). */
const SHARE_MESSAGE = "Book a time with me: {link}";

const attr = (s: string) => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

/** The code a website owner pastes into a page (rule 24). */
export function embedCode(format: Format, url: string, redirect: Redirect): string {
  const framed = `${url}?embed=1&redirect=${redirect}`;
  const size = "width:100%;height:760px;border:0";
  switch (format) {
    case "script":
      return [
        `<div class="tempoloom-embed" data-url="${attr(framed)}"><a href="${attr(url)}">Book a time</a></div>`,
        `<script src="${new URL(url).origin}/embed.js" async></script>`,
      ].join("\n");
    case "object":
      return `<object data="${attr(framed)}" type="text/html" style="${size}"><a href="${attr(url)}">Book a time</a></object>`;
    case "iframe":
      return `<iframe src="${attr(framed)}" title="Book a time" style="${size}"></iframe>`;
    case "url":
      return url;
  }
}

export function SharePanel({
  title,
  url,
  onClose,
}: {
  title: string;
  url: string;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<Format>("script");
  const [redirect, setRedirect] = useState<Redirect | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    // The last redirect mode the user chose (rule 25).
    void api<{ embedRedirect: Redirect }>("GET", "/api/booking/share-prefs").then((p) =>
      setRedirect(p.embedRedirect),
    );
  }, []);
  const copy = (text: string, what: string) =>
    void navigator.clipboard
      ?.writeText(text)
      .then(() => setCopied(what))
      .catch(() => {});
  const enc = encodeURIComponent(url);
  const social: [string, string][] = [
    ["LinkedIn", `https://www.linkedin.com/sharing/share-offsite/?url=${enc}`],
    ["X", `https://x.com/intent/post?url=${enc}&text=${encodeURIComponent(title)}`],
    ["Facebook", `https://www.facebook.com/sharer/sharer.php?u=${enc}`],
  ];
  const mail = `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(
    SHARE_MESSAGE.replace("{link}", url),
  )}`;
  if (redirect === null) return null;
  const code = embedCode(format, url, redirect);
  return (
    <section class="panel" data-testid="share-panel">
      <h2>Share {title}</h2>
      <div class="actions">
        <button type="button" onClick={() => copy(url, "URL")}>
          Copy URL
        </button>
        <a href={mail}>Email</a>
        {social.map(([name, href]) => (
          <a href={href} target="_blank" rel="noopener noreferrer" key={name}>
            {name}
          </a>
        ))}
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <h3>Embed on a website</h3>
      <div class="actions">
        {FORMATS.map(([value, label]) => (
          <label class="inline" key={value}>
            <input
              type="radio"
              name="embed-format"
              checked={format === value}
              onChange={() => setFormat(value)}
            />
            {label}
          </label>
        ))}
      </div>
      <p class="status">
        {format === "script"
          ? "Recommended: the script sizes the frame to the page and follows page design changes."
          : format === "url"
            ? "The plain URL of the booking page."
            : "A frame of fixed height. Change the height in the code if you need to."}
      </p>
      <details open>
        <summary>Advanced options</summary>
        <label>
          After a booking in the embed
          <select
            value={redirect}
            onChange={(e) => {
              const mode = e.currentTarget.value as Redirect;
              setRedirect(mode);
              void api("PUT", "/api/booking/share-prefs", { embedRedirect: mode });
            }}
          >
            {REDIRECTS.map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <p class="status">
          This applies when the link has a redirect URL. "Only the frame" needs a target page that
          allows framing.
        </p>
      </details>
      <label>
        Embed code
        <textarea readOnly rows={4} value={code} />
      </label>
      <div class="actions">
        <button type="button" onClick={() => copy(code, "code")}>
          Copy code
        </button>
        {copied && <span class="status">Copied the {copied}.</span>}
      </div>
    </section>
  );
}
