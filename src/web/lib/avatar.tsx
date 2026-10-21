// The user's picture from the main Google account, or initials when there is
// none (docs/specs/settings-profile.md PRF-5, edge case 1). no-referrer: the
// picture host does not learn which page the visitor opened.

export function initials(name: string): string {
  const words = name
    .trim()
    .split(/[\s@._-]+/)
    .filter(Boolean);
  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? (words.at(-1)?.[0] ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

export function Avatar({ url, name, testId }: { url: string; name: string; testId: string }) {
  return url ? (
    <img
      class="avatar"
      src={url}
      alt=""
      width={64}
      height={64}
      referrerpolicy="no-referrer"
      data-testid={testId}
    />
  ) : (
    <span class="avatar avatar-initials" aria-hidden="true" data-testid={`${testId}-initials`}>
      {initials(name)}
    </span>
  );
}
