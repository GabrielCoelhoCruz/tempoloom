// Profile page (docs/specs/settings-profile.md PRF-1, PRF-4, PRF-8): the
// fields that come from the calendar account are read-only; the user's own
// fields are saved when they change.
import { useState } from "preact/hooks";
import type { Settings } from "../../server/settings.ts";
import { COMPANY_SIZES, USE_CASES } from "../../shared/profile.ts";
import { api } from "../lib/api.ts";
import { Avatar } from "../lib/avatar.tsx";
import { useCommit } from "../lib/commit-input.ts";
import { loadMe, me } from "../lib/state.ts";
import "./pages.css";

const DATE_FORMATS: Record<Settings["dateFormat"], string> = {
  YMD: "Year-month-day",
  DMY: "Day-month-year",
  MDY: "Month-day-year",
};

const USE_CASE_LABELS: Record<(typeof USE_CASES)[number], string> = {
  work: "Work",
  personal: "Personal",
  both: "Work and personal",
};

export function ProfilePage() {
  const m = me.value;
  const [message, setMessage] = useState<string | null>(null);
  const save = async (patch: Partial<Settings["profile"]>) => {
    setMessage(null);
    try {
      await api("PATCH", "/api/settings", { profile: patch });
      await loadMe();
      setMessage("Saved");
    } catch {
      setMessage("That did not save. Try again.");
    }
  };
  const jobTitle = useCommit(m?.settings.profile.jobTitle ?? "", (v) => save({ jobTitle: v }));
  const company = useCommit(m?.settings.profile.company ?? "", (v) => save({ company: v }));
  if (!m) return null;
  const profile = m.settings.profile;
  return (
    <div class="page" data-testid="profile-page">
      <h1>Profile</h1>
      {message && (
        <p class="status notice" data-testid="profile-message">
          {message}
        </p>
      )}
      <section data-testid="profile-fixed">
        <h2>From your calendar account</h2>
        <Avatar
          url={m.user.avatarUrl}
          name={m.user.name || m.user.email}
          testId="profile-picture"
        />
        <div class="list">
          <div class="row">
            <span>Name</span>
            <strong>{m.user.name}</strong>
          </div>
          <div class="row">
            <span>Email</span>
            <strong>{m.user.email}</strong>
          </div>
          <div class="row">
            <span>Time zone</span>
            <strong>{m.user.time_zone}</strong>
          </div>
          <div class="row">
            <span>Planning week starts on</span>
            <strong>{m.settings.weekStart === 7 ? "Sunday" : "Monday"}</strong>
          </div>
          {m.settings.googleWeekStart !== null && (
            <div class="row">
              <span>Week start in your Google calendar (planner and dates)</span>
              <strong>{m.settings.googleWeekStart === 7 ? "Sunday" : "Monday"}</strong>
            </div>
          )}
          <div class="row">
            <span>Time format</span>
            <strong>{m.settings.timeFormat === "12h" ? "12-hour" : "24-hour"}</strong>
          </div>
          <div class="row">
            <span>Date format</span>
            <strong>{DATE_FORMATS[m.settings.dateFormat]}</strong>
          </div>
        </div>
        <p class="status">
          Change these in your calendar account; Tempoloom reads them from there. Plan in another
          zone for a while with a travel time zone in Settings.
        </p>
      </section>
      <section>
        <h2>About you</h2>
        <div class="form">
          <label>
            Job title
            <input maxLength={100} {...jobTitle} />
          </label>
          <label>
            Company
            <input maxLength={100} {...company} />
          </label>
          <label>
            Company size
            <select
              value={profile.companySize}
              onChange={(e) =>
                void save({
                  companySize: e.currentTarget.value as Settings["profile"]["companySize"],
                })
              }
            >
              <option value="">Not set</option>
              {COMPANY_SIZES.map((s) => (
                <option value={s} key={s}>
                  {s === "1" ? "Just me" : `${s} people`}
                </option>
              ))}
            </select>
          </label>
          <label>
            Use case
            <select
              value={profile.useCase}
              onChange={(e) =>
                void save({ useCase: e.currentTarget.value as Settings["profile"]["useCase"] })
              }
            >
              <option value="">Not set</option>
              {USE_CASES.map((u) => (
                <option value={u} key={u}>
                  {USE_CASE_LABELS[u]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>
    </div>
  );
}
