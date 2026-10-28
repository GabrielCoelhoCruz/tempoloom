// The tabs of the stats page: mine, team and organization. This file is in the
// first chunk; the shared parts of the lazy team and organization views are in
// stats-range.tsx.
import { onLinkClick, path } from "../lib/router.ts";
import "./pages.css";

const TABS = [
  ["/stats", "My stats"],
  ["/stats/team", "Team stats"],
  ["/stats/organization", "Organization"],
] as const;

export function StatsTabs() {
  return (
    <nav class="tabs" aria-label="Stats views" data-testid="stats-tabs">
      {TABS.map(([href, label]) => (
        <a
          key={href}
          href={href}
          onClick={onLinkClick}
          aria-current={path.value === href ? "page" : undefined}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}
