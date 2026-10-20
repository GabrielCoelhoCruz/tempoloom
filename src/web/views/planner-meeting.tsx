// Planner actions on a flexible meeting occurrence
// (docs/specs/meetings-flexible-rescheduling.md rules 19, 20 and 26): the
// organizer reschedules to another time the same day or to another day of the
// period; the guest of a 1:1 can do the same and skip; a group meeting's guest
// only answers the invitation.
import type { PlannerEvent } from "../../server/api/planner.ts";
import { ApiError, api } from "../lib/api.ts";

export function MeetingActions({
  event,
  run,
  close,
}: {
  event: PlannerEvent;
  run: (fn: () => Promise<unknown>) => void;
  close: () => void;
}) {
  if (event.guest && !event.guest.oneOnOne)
    return (
      <p class="status" data-testid="meeting-guest-note">
        Only the organizer can change a group meeting.
      </p>
    );
  const act = (path: string, body?: unknown) => {
    close();
    run(() =>
      api("POST", `/api/meetings/occurrences/${event.id}/${path}`, body).catch((err: unknown) => {
        const message = err instanceof ApiError && (err.body as { message?: string })?.message;
        throw message ? new Error(message) : err;
      }),
    );
  };
  return (
    <div class="actions" data-testid="meeting-actions">
      <button type="button" onClick={() => act("reschedule", { option: "sameDay" })}>
        Reschedule: same day
      </button>
      <button type="button" onClick={() => act("reschedule", { option: "otherDay" })}>
        Reschedule: another day
      </button>
      {event.guest && (
        <button type="button" onClick={() => act("skip")}>
          Skip this time
        </button>
      )}
    </div>
  );
}
