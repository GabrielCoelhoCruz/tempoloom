/**
 * Every automation type, in the scheduler's order inside one priority and rank
 * (planning-scheduler.md); meeting checks, without a table, last. The server's
 * automation list and the scheduler both read this one list.
 */
export const AUTOMATION_TYPES = [
  "flexible_meeting",
  "buffer",
  "habit",
  "meeting_overload",
  "focus_time",
  "meeting_check",
] as const;
export type AutomationType = (typeof AUTOMATION_TYPES)[number];
