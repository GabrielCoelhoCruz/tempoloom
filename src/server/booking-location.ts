// Location options of a booking link (docs/specs/booking-links.md, location
// option). `booking_links.locations` is the one source; the `location` column
// keeps a copy of the default's text for SQL readers (the reminder query).

/** A location option; the first of a link's list is the default. */
export interface LocationOption {
  kind: "address" | "phone" | "custom";
  value: string;
}

/** The link's location options, default first. */
export function locationsOf(link: { locations: string }): LocationOption[] {
  return JSON.parse(link.locations || "[]") as LocationOption[];
}

/** The default option, or null when the link has none. */
export function defaultLocation(link: { locations: string }): LocationOption | null {
  return locationsOf(link)[0] ?? null;
}

/** The text of an option for the event, the emails and the page ("" for none). */
export const locationText = (o: LocationOption | null | undefined): string => o?.value ?? "";

/**
 * The option a booking was made with: the link's option with that text, or
 * the text as a custom option when the link no longer has it.
 */
export function bookedLocation(
  link: { locations: string },
  text: string | null,
): LocationOption | null {
  if (text === null) return defaultLocation(link);
  if (!text) return null;
  return locationsOf(link).find((o) => o.value === text) ?? { kind: "custom", value: text };
}

/** Availability rule 10: travel time applies only when the location is an address. */
export const needsTravel = (o: LocationOption | null | undefined): boolean => o?.kind === "address";
