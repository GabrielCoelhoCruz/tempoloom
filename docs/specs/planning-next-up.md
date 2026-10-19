# Next up and task suggestions

Spec id: SPEC-PLANNING-03
Evidence: E-0005 (ev_a5be14921792), E-0010 (ev_3ce2126cfbf4), E-0056 (ev_aa85baa4a4a9), E-0077 (ev_38c8b46b5b57), E-0081 (ev_dfcc5d3b7c8c), E-0098 (ev_cefc23278fd5), E-0132 (ev_a9d46d5e4718), E-0139 (ev_28aa8ef849b8), E-0183 (ev_000dae433420), E-0192 (ev_d71469f89e0b), E-0193 (ev_68ba14aa780b), E-0209 (ev_28b6d44e4b68), E-0212 (ev_7a9bb324e265)
Status of evidence: public docs only

## Summary

"Next up" tells the user which task to work on now. Tempoloom offers two
tools for it. The next-up queue (legacy evidence) is a hand-ranked list of
tasks that the scheduler places before all other tasks. Task suggestions
(current reference) show a short list of tasks that fit the current moment,
and can be tied to focus time and habit events through saved task searches.

## Concepts and inputs

- **Next-up queue**: an ordered list of open tasks. Each entry has a rank
  1..n. A task is in the queue when its `nextUp` flag is true.
- **Task search**: a saved filter over open tasks. Fields: source (Tempoloom
  or one integration), keyword (text in the task title), due date range, and,
  for integration tasks, project and label (E-0192).
- **Search assignment**: a link from one focus time automation or one habit to
  one task search (E-0192, E-0081, E-0077).
- **Suggestion lists**: "Suggested now" and "At risk" (E-0192).

## Behavior

### Next-up queue (legacy evidence)

- **NXT-1.** A task in the queue goes before every task outside the queue in
  the scheduler order, whatever its priority, including P1 tasks (legacy
  evidence, E-0209, E-0212).
- **NXT-2.** Inside the queue, the rank decides the order, not the priority
  or due date. The user changes the rank by drag and drop (legacy evidence,
  E-0212).
- **NXT-3.** The scheduler places queue tasks as early as possible (legacy
  evidence, E-0212, E-0193).
- **NXT-4.** Queue tasks do not go before everything. Locked events stay in
  place and queue tasks fit around them. P1 habits and P1 flexible meetings
  go before queue tasks (legacy evidence, E-0209, E-0212). Exact position in
  the order: `planning-scheduler.md`, section "Processing order".
- **NXT-5.** The user adds a task to the queue with an "up" arrow button on
  the task, or by drag and drop into the queue area at the top of the task
  list. The queue area has a dashed outline (legacy evidence, E-0212, E-0139).
- **NXT-6.** The add action exists on the tasks page, in the planner tasks
  panel, on the priorities page, in the Google Calendar add-on and in the
  chat-app integration (legacy evidence, E-0132, E-0212).
- **NXT-7.** The task creation form has a switch to put the new task in the
  queue (legacy evidence, E-0193, E-0212).
- **NXT-8.** The user setting `defaultNextUp` puts every new task in the queue.
  Default: off (legacy evidence, E-0056, E-0212).
- **NXT-9.** A new queue entry gets the last rank. Proposed default; the
  evidence is silent.
- **NXT-10.** The user removes a task from the queue with a "down" arrow
  button or by drag and drop out of the queue area. The task then returns to
  normal priority order (legacy evidence, E-0212).
- **NXT-11.** Marking a task done or deleting it removes it from the queue.
  Proposed default.

### Next-up task

- **NXT-20.** Proposed default for the next-up task shown in the planner
  ("what is next", E-0010): with chunk placement, it is the task whose chunk
  is in progress now; otherwise the task with the earliest future chunk today;
  otherwise the first open task in scheduler order. With suggestions only,
  it is the first item of "Suggested now".

### Task suggestions (current reference)

- **NXT-30.** The tasks panel shows two lists: "Suggested now" (tasks that fit
  the current context) and "At risk" (tasks that need care soon because of
  their dates or their level) (E-0192).
- **NXT-31.** The inputs for suggestions are: due date, priority, the current
  calendar event, the hours sets, the user's saved preferences in the
  assistant chat, and task details (title, description, project, labels,
  source) (E-0192).
- **NXT-32.** Proposed default rule for "Suggested now": open tasks with
  `startAfter` at or before now and `remainingMinutes` > 0, filtered by the
  task search of the current focus time or habit event if one is assigned,
  ordered by scheduler order, first 5 shown.
- **NXT-33.** Proposed default rule for "At risk": open tasks that are past
  due, or that the scheduler could not fully place before the due date, or
  (with suggestions only) that are due within 48 hours.
- **NXT-34.** The user can ask the assistant chat which task to do next, for a
  short task, or for another choice (E-0192, E-0098).

### Task searches tied to focus time and habits (current reference)

- **NXT-40.** The user can assign one task search to a focus time automation
  and one to each habit. The user does this from the automation editor or by
  selecting one of its events in the planner (E-0192, E-0081).
- **NXT-41.** The search is saved, not a snapshot. The list updates when
  tasks are added, done or changed (E-0192).
- **NXT-42.** When an event of that automation is current, the tasks panel
  shows the tasks that match its search (E-0192).
- **NXT-43.** A task search assignment does not change when or how the focus
  time or habit events are placed (E-0192).
- **NXT-44.** One focus time search covers all focus time events; every
  habit can hold a separate search (E-0077, E-0192).
- **NXT-45.** The user can also assign a task search to the meeting overload
  automation. Its events exist only when the meeting limit is reached, so the
  list may never show (E-0192).
- Tempoloom decision for NXT-40 to NXT-45: a task search has a name, a
  keyword that the task title must contain (case-insensitive; empty matches
  every task) and an optional "due within N days". It searches open Tempoloom
  tasks; integration sources, projects and labels come with the task
  integrations. Matching tasks are listed in the tasks page order (due date,
  then creation). The user assigns a search in the habit editor, the focus
  options, the meeting overload form, and the details panel of any event of
  the automation, where the user can also create a search. While a habit or
  focus event with a search runs, the planner shows a "Now:" panel with the
  matching tasks. An empty result shows "No open task matches <name>."

### Work blocks on request (current reference)

- **NXT-50.** The user can ask the assistant chat to block time for tasks.
  Tempoloom proposes one or more work-block events as a preview. The user
  changes, discards or applies them (E-0192). Chat details: assistant chat
  spec.

## Outputs

- The scheduler order changes for queue tasks; their chunks move earlier.
- Planner tasks panel: the queue area, the task list, "Suggested now" and
  "At risk" lists, and the next-up task.
- No calendar event changes from suggestions or search assignments.

## Edge cases

1. A queue task has `startAfter` in the future: it waits until then; the
   queue rank still applies after that time.
2. A queue task is locked: the lock wins; the chunk stays where it is.
3. All open tasks are in the queue: the scheduler orders all tasks by rank
   only (legacy evidence, E-0212).
4. A task search matches no open task: the panel shows an empty list with
   the search name. Proposed default.
5. A task synced from an integration is in the queue and then closed in the
   source app: Proposed default: it leaves the queue when it becomes done.

## Observed API shapes

Not yet observed.

## Open questions

1. Where exactly do queue tasks sit relative to P2 to P4 habits and
   meetings? The evidence only says P1 habits and meetings go first.
   Proposed default: queue tasks are processed right after P1 meetings and P1
   habits (see `planning-scheduler.md`).
2. How does the current reference rank "Suggested now"? Proposed default in
   NXT-32.
3. Does the current reference keep a hand-ranked queue? The
   current-version pages do not mention it.

## Acceptance tests

Fixture F0 from `planning-scheduler.md`.

1. **Queue beats priority.** Setup: task "AT-N1a" P1, 240 minutes, due Friday
   W; task "AT-N1b" P4, 120 minutes, due Friday W+1; both `startAfter` Monday
   W. Action: add "AT-N1b" to the queue. Expected within 60 s: the first
   "AT-N1b" event starts before the first "AT-N1a" event, and starts at Monday
   W 09:00. Reload: same order.
2. **Queue rank decides.** Setup: tasks "AT-N2x" and "AT-N2y", both in the
   queue in that order, 120 minutes each. Action: drag "AT-N2y" above
   "AT-N2x". Expected within 60 s: the first "AT-N2y" event starts before the
   first "AT-N2x" event. Reload: the queue shows "AT-N2y" first.
3. **P1 habit stays before the queue.** Setup: P1 habit "AT-N3 Lunch",
   60 minutes, every weekday, window 12:00 to 13:00; queue task "AT-N3 Big",
   480 minutes, chunks up to 240. Action: create the queue task. Expected:
   lunch events stay at 12:00 to 13:00 on each day of W; no "AT-N3 Big" event
   overlaps them. Reload: same.
4. **Removing from the queue.** Setup: test 1 done. Action: remove
   "AT-N1b" from the queue. Expected within 60 s: the first "AT-N1a" event
   starts before the first "AT-N1b" event. Reload: same.
5. **Default puts new tasks in the queue.** Setup: `defaultNextUp` on. Action:
   create task "AT-N5". Expected: "AT-N5" shows in the queue at the last rank.
   Reload: same.
6. **Search assigned to focus time.** Setup: `taskPlacement` `suggestions`;
   tasks "Report Q3" and "Email vendor"; a focus time automation in hours
   AT-Always with a search "keyword: report". Action: open the planner while
   a focus event is current. Expected: the tasks panel lists "Report Q3" and
   not "Email vendor"; no new calendar event exists for either task. Reload:
   same list.
