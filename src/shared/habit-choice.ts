// The stored choice of one habit occurrence (table habit_reschedules,
// habits-automation.md rules 29 to 31). `minute` counts from the occurrence
// date (chosenMinute in time.ts); its day is chosenDay.

/** Values of `habit_reschedules.not_before`. */
export const HabitChoice = {
  /** Rule 30: the minute is a reschedule time (the legal slot nearest to it). */
  reschedule: 0,
  /** Rule 31: the minute is a snooze time (the first legal start at or after it). */
  snooze: 1,
  /**
   * Rule 29: the start of the day of a deleted event of an occurrence whose
   * date has passed. The plan places the occurrence again on that day.
   */
  eventDay: 2,
} as const;

/**
 * SQL for the chosen day (YYYY-MM-DD) of a habit_reschedules row, as chosenDay
 * does: the date plus the whole days of `minute`, rounded down. `table`: an
 * alias or table name to qualify the columns with.
 */
export function chosenDaySql(table = ""): string {
  const c = table ? `${table}.` : "";
  return `date(${c}date, ((${c}minute - ((${c}minute % 1440) + 1440) % 1440) / 1440) || ' days')`;
}
