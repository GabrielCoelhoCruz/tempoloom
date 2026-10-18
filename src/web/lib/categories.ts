// Labels for event categories and Google's 11 event colors (events-categories-and-colors.md).
import type { Category } from "../../scheduler/categories.ts";

export const CATEGORY_LABELS: Record<Category, string> = {
  team_meeting: "Team meeting",
  one_on_one: "One-on-one",
  external_meeting: "External meeting",
  solo_work: "Solo work",
  personal: "Personal",
  travel: "Travel",
  flight: "Flight",
  vacation: "Vacation",
  personal_commitment: "Personal commitment",
};

export const COLORS: { id: string; name: string; hex: string }[] = [
  { id: "1", name: "Lavender", hex: "#7986cb" },
  { id: "2", name: "Sage", hex: "#33b679" },
  { id: "3", name: "Grape", hex: "#8e24aa" },
  { id: "4", name: "Flamingo", hex: "#e67c73" },
  { id: "5", name: "Banana", hex: "#f6bf26" },
  { id: "6", name: "Tangerine", hex: "#f4511e" },
  { id: "7", name: "Peacock", hex: "#039be5" },
  { id: "8", name: "Graphite", hex: "#616161" },
  { id: "9", name: "Blueberry", hex: "#3f51b5" },
  { id: "10", name: "Basil", hex: "#0b8043" },
  { id: "11", name: "Tomato", hex: "#d50000" },
];
