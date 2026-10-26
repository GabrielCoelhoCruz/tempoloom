// Planner ids of calendar events: "ext:<calendar id>:<event id>". The MCP and
// chat tools, preview mode and the chat context all read them through here.

/** The calendar and event of an ext: id, or null for another id. */
export function extId(id: string): { calendarId: string; eventId: string } | null {
  if (!id.startsWith("ext:")) return null;
  const rest = id.slice(4);
  const cut = rest.indexOf(":");
  if (cut <= 0 || cut === rest.length - 1) return null;
  return { calendarId: rest.slice(0, cut), eventId: rest.slice(cut + 1) };
}
