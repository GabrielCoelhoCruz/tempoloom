// Input checks for the event settings of habits, focus time and buffers
// (src/shared/event-settings.ts holds the model and the defaults).
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  defaultEventSettings,
  type EventSettings,
  ITEM_COLORS,
  type SettingsKind,
  VISIBILITIES,
} from "../shared/event-settings.ts";
import { type Db, one } from "./db.ts";

/** One emoji: pictographs with their joiners and variation selectors, no text. */
const EMOJI =
  /^(?=.*[\p{Extended_Pictographic}\p{Regional_Indicator}])(?:\p{Extended_Pictographic}|\p{Emoji_Component})+$/u;

export const eventSettingsInput = z
  .object({
    emoji: z
      .string()
      .trim()
      .max(16)
      .refine((v) => v === "" || EMOJI.test(v), "Use one emoji, or leave it empty"),
    color: z.enum(ITEM_COLORS),
    visibility: z.enum(VISIBILITIES),
    reminders: z.union([
      z.enum(["default", "none"]),
      z
        .array(
          z
            .number()
            .int()
            .min(0)
            .max(28 * 24 * 60),
        )
        .min(1)
        .max(5),
    ]),
    location: z.string().trim().max(1000),
    calendarId: z.string().nullable(),
    description: z.string().max(10_000),
    category: z.enum(["work", "personal"]),
  })
  .partial();

export type EventSettingsInput = z.infer<typeof eventSettingsInput>;

/** The settings with the given fields replaced; missing fields stay. */
function merged(base: EventSettings, input: EventSettingsInput | undefined): EventSettings {
  const out = { ...base };
  for (const [k, v] of Object.entries(input ?? {})) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function fail(path: string, message: string): never {
  throw new HTTPException(400, {
    res: Response.json(
      { error: "invalid_body", issues: [{ path: `eventSettings.${path}`, message }] },
      { status: 400 },
    ),
  });
}

/** Settings of a new automation: the defaults of its kind, then the input. */
export function newEventSettings(
  db: Db,
  userId: string,
  kind: SettingsKind,
  input: EventSettingsInput | undefined,
  opts: { travel?: boolean; personal?: boolean } = {},
): EventSettings {
  const s = merged(defaultEventSettings(kind, opts), input);
  if (
    s.calendarId !== null &&
    !one(
      db,
      `SELECT 1 FROM calendars c JOIN accounts a ON a.id = c.account_id
       WHERE c.id = ? AND a.user_id = ? AND a.status = 'ok' AND c.writable = 1`,
      s.calendarId,
      userId,
    )
  ) {
    fail("calendarId", "Choose one of your calendars that Tempoloom can write to");
  }
  return s;
}

/** Settings after an edit. The calendar is set at creation only (habits rule 5). */
export function editedEventSettings(
  stored: EventSettings,
  input: EventSettingsInput | undefined,
): EventSettings {
  if (input?.calendarId !== undefined && input.calendarId !== stored.calendarId) {
    fail("calendarId", "The calendar is set when the automation is created");
  }
  return merged(stored, input);
}
