import { signal } from "@preact/signals";

export const path = signal(location.pathname);

export function navigate(to: string): void {
  if (to === location.pathname + location.search) return;
  history.pushState(null, "", to);
  path.value = location.pathname;
}

addEventListener("popstate", () => {
  path.value = location.pathname;
});

/** Click handler for in-app links: keeps modifier-clicks and new tabs working. */
export function onLinkClick(e: MouseEvent): void {
  const a = (e.currentTarget as HTMLAnchorElement | null) ?? null;
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  navigate(a.getAttribute("href") ?? "/");
}
