// Append-only list. Never edit a migration that has shipped; add a new one.
export const MIGRATIONS: readonly string[] = [
  // 1: identity, calendar accounts and the event cache
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    time_zone TEXT NOT NULL DEFAULT 'UTC',
    settings TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE oauth_states (
    state TEXT PRIMARY KEY,
    code_verifier TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;

  -- One-time sign-in links made by an operator with the CLI.
  CREATE TABLE login_links (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('google', 'google_service', 'caldav')),
    -- Google subject, service account email, or CalDAV server and user name.
    external_id TEXT NOT NULL,
    email TEXT NOT NULL,
    server_url TEXT,
    -- Sealed JSON: a refresh token, or CalDAV credentials.
    credentials TEXT NOT NULL,
    access_token TEXT,
    access_expires_at INTEGER NOT NULL DEFAULT 0,
    scope TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'reauth_required')),
    created_at INTEGER NOT NULL,
    UNIQUE (provider, external_id)
  ) STRICT;
  CREATE INDEX accounts_user ON accounts(user_id);

  CREATE TABLE calendars (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    provider_id TEXT NOT NULL,
    name TEXT NOT NULL,
    time_zone TEXT,
    writable INTEGER NOT NULL DEFAULT 1,
    is_primary INTEGER NOT NULL DEFAULT 0,
    color TEXT,
    -- Busy events on this calendar block time for scheduling.
    check_availability INTEGER NOT NULL DEFAULT 0,
    sync_token TEXT,
    window_start INTEGER,
    window_end INTEGER,
    synced_at INTEGER,
    UNIQUE (account_id, provider_id)
  ) STRICT;

  CREATE TABLE events (
    calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    all_day INTEGER NOT NULL DEFAULT 0,
    busy INTEGER NOT NULL DEFAULT 1,
    event_type TEXT NOT NULL DEFAULT 'default',
    self_response TEXT,
    attendee_count INTEGER NOT NULL DEFAULT 0,
    organizer_self INTEGER NOT NULL DEFAULT 1,
    recurring_id TEXT,
    color_id TEXT,
    etag TEXT,
    updated_ms INTEGER,
    private_props TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (calendar_id, event_id)
  ) STRICT;
  CREATE INDEX events_time ON events(calendar_id, start_ms, end_ms);
  `,
  // 2: managed events written to calendars
  `
  CREATE TABLE managed_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    event_id TEXT,
    key TEXT NOT NULL,
    kind TEXT NOT NULL,
    source_id TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    busy INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color_id TEXT,
    locked INTEGER NOT NULL DEFAULT 0,
    -- The user changed the title in the calendar; Tempoloom keeps it.
    user_edited INTEGER NOT NULL DEFAULT 0,
    etag TEXT,
    UNIQUE (user_id, key)
  ) STRICT;
  CREATE INDEX managed_events_source ON managed_events(user_id, kind, source_id);
  CREATE INDEX managed_events_event ON managed_events(calendar_id, event_id);
  `,
  // 3: planning items
  `
  CREATE TABLE hours_sets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('work', 'personal', 'meeting', 'custom')),
    name TEXT NOT NULL,
    -- JSON: { "1": [[540, 1020]], ... } local minutes per ISO weekday.
    weekly TEXT NOT NULL,
    task_calendar_id TEXT REFERENCES calendars(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX hours_sets_user ON hours_sets(user_id);

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 4),
    total_minutes INTEGER NOT NULL,
    logged_minutes INTEGER NOT NULL DEFAULT 0,
    min_chunk_minutes INTEGER NOT NULL,
    max_chunk_minutes INTEGER NOT NULL,
    start_after INTEGER NOT NULL,
    due_at INTEGER,
    hours_set_id TEXT NOT NULL REFERENCES hours_sets(id),
    next_up_rank INTEGER,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
    created_at INTEGER NOT NULL,
    rules_changed_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX tasks_user ON tasks(user_id, status);

  CREATE TABLE habits (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 4),
    rank INTEGER NOT NULL DEFAULT 0,
    hours_set_id TEXT NOT NULL REFERENCES hours_sets(id),
    ideal_minute INTEGER NOT NULL,
    min_minutes INTEGER NOT NULL,
    max_minutes INTEGER NOT NULL,
    -- JSON: {"period":"daily"} or {"period":"weekly","days":[1,3]}
    frequency TEXT NOT NULL,
    starting TEXT,
    defense TEXT NOT NULL CHECK (defense IN ('adaptive', 'always-free', 'always-busy')),
    when_unplaceable TEXT NOT NULL CHECK (when_unplaceable IN ('remove', 'keep_as_conflict')),
    reserved_words TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    rules_changed_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX habits_user ON habits(user_id);

  CREATE TABLE buffers (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 4),
    rank INTEGER NOT NULL DEFAULT 0,
    side TEXT NOT NULL CHECK (side IN ('before', 'after', 'both')),
    minutes_before INTEGER NOT NULL DEFAULT 0,
    minutes_after INTEGER NOT NULL DEFAULT 0,
    busy INTEGER NOT NULL DEFAULT 1,
    filter TEXT NOT NULL DEFAULT '{}',
    on_conflict TEXT NOT NULL CHECK (on_conflict IN ('remove', 'keep_as_conflict')),
    created_at INTEGER NOT NULL,
    rules_changed_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE focus_goals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    hours_set_id TEXT NOT NULL REFERENCES hours_sets(id),
    weekly_goal_minutes INTEGER NOT NULL,
    daily_min_minutes INTEGER NOT NULL,
    daily_max_minutes INTEGER NOT NULL,
    min_block_minutes INTEGER NOT NULL,
    max_block_minutes INTEGER NOT NULL,
    busy INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    rules_changed_at INTEGER NOT NULL
  ) STRICT;

  -- Time ranges an item must not use again (deleted or moved events).
  CREATE TABLE item_exclusions (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX item_exclusions_item ON item_exclusions(user_id, kind, item_id);

  -- Demand keys the user dismissed: skipped habit days and deleted buffers.
  CREATE TABLE dismissed_keys (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  ) STRICT;

  CREATE TABLE plan_reports (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    report TEXT NOT NULL,
    planned_at INTEGER NOT NULL
  ) STRICT;
  `,
  // 4: periodic refresh of each account's calendar list
  `
  ALTER TABLE accounts ADD COLUMN calendars_synced_at INTEGER;
  `,
  // 5: booking links
  `
  CREATE TABLE booking_pages (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    slug TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE booking_links (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    title_template TEXT NOT NULL,
    durations TEXT NOT NULL,
    level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 4),
    hours_set_id TEXT REFERENCES hours_sets(id) ON DELETE SET NULL,
    notice_minutes INTEGER NOT NULL DEFAULT 240,
    range_end_days INTEGER NOT NULL DEFAULT 30,
    buffer_before INTEGER NOT NULL DEFAULT 0,
    buffer_after INTEGER NOT NULL DEFAULT 0,
    max_per_day INTEGER,
    max_per_week INTEGER,
    location TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, slug)
  ) STRICT;

  CREATE TABLE bookings (
    id TEXT PRIMARY KEY,
    link_id TEXT REFERENCES booking_links(id) ON DELETE SET NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    calendar_id TEXT,
    event_id TEXT,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    token_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('booked', 'cancelled')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX bookings_link ON bookings(link_id, status, start_ms);
  `,
  // 6: calendar mirroring policies
  `
  CREATE TABLE mirror_policies (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    dest_calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    calendar_type TEXT NOT NULL CHECK (calendar_type IN ('personal', 'business', 'travel')),
    visibility TEXT NOT NULL CHECK (visibility IN ('label_only', 'busy_only', 'details_private', 'details_default')),
    all_day_mode TEXT NOT NULL CHECK (all_day_mode IN ('none', 'busy_only', 'all')),
    copy_outside_work_hours INTEGER NOT NULL DEFAULT 1,
    no_reply_busy INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    CHECK (source_calendar_id <> dest_calendar_id)
  ) STRICT;
  CREATE INDEX mirror_policies_user ON mirror_policies(user_id);
  `,
  // 7: priority of external events (only booking links read it)
  `
  CREATE TABLE external_levels (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    -- An event id, or the series id when the level applies to a whole series.
    target_id TEXT NOT NULL,
    level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 4),
    PRIMARY KEY (user_id, calendar_id, target_id)
  ) STRICT;
  `,
  // 8: outgoing webhooks for booking links
  `
  CREATE TABLE webhook_endpoints (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE booking_link_webhooks (
    link_id TEXT NOT NULL REFERENCES booking_links(id) ON DELETE CASCADE,
    endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
    PRIMARY KEY (link_id, endpoint_id)
  ) STRICT;

  CREATE TABLE webhook_deliveries (
    id TEXT PRIMARY KEY,
    endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    event_ts INTEGER NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'delivered')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_result TEXT,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
  ) STRICT;
  CREATE INDEX webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);

  -- Custom data from the booking page URL, sent in every webhook of the meeting.
  ALTER TABLE bookings ADD COLUMN custom_data TEXT NOT NULL DEFAULT '{"data":{},"errors":[]}';
  `,
  // 9: flexible meetings (docs/specs/meetings-flexible.md)
  `
  CREATE TABLE meetings (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 4),
    rank INTEGER NOT NULL DEFAULT 0,
    -- JSON: {"period":"daily"} or {"period":"weekly","everyWeeks":1,"idealDays":[2]}
    frequency TEXT NOT NULL,
    ideal_minute INTEGER NOT NULL,
    duration_minutes INTEGER NOT NULL,
    shortest_minutes INTEGER NOT NULL,
    hours_mode TEXT NOT NULL CHECK (hours_mode IN ('everyone', 'organizer')),
    hours_set_id TEXT NOT NULL REFERENCES hours_sets(id),
    starting TEXT,
    defense TEXT NOT NULL CHECK (defense IN ('adaptive', 'busy', 'free')),
    when_unplaceable TEXT NOT NULL CHECK (when_unplaceable IN ('remove', 'keep_as_conflict')),
    lead_minutes INTEGER NOT NULL DEFAULT 720,
    created_at INTEGER NOT NULL,
    rules_changed_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX meetings_user ON meetings(user_id);

  CREATE TABLE meeting_attendees (
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    required INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (meeting_id, email)
  ) STRICT;
  CREATE INDEX meeting_attendees_email ON meeting_attendees(email);

  -- Guests and location of a managed event, as JSON; a change rewrites the event.
  ALTER TABLE managed_events ADD COLUMN extra TEXT NOT NULL DEFAULT '';
  `,
  // 10: event categories and colors (docs/specs/events-categories-and-colors.md)
  `
  ALTER TABLE events ADD COLUMN attendees TEXT NOT NULL DEFAULT '[]';

  -- A category the user set on one event (rule 4).
  CREATE TABLE event_categories (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL,
    category TEXT NOT NULL,
    PRIMARY KEY (user_id, calendar_id, event_id)
  ) STRICT;
  `,
  // 11: teams (docs/specs/teams-membership.md, teams-settings-templates.md)
  `
  CREATE TABLE teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    -- Email domain of the creator; same-domain users can find the team.
    domain TEXT NOT NULL,
    join_mode TEXT NOT NULL DEFAULT 'request' CHECK (join_mode IN ('invite_only', 'request', 'automatic')),
    invite_permission TEXT NOT NULL DEFAULT 'admins' CHECK (invite_permission IN ('admins', 'all_members')),
    -- Set by the operator (CLI); NULL means the instance default.
    seat_limit INTEGER,
    -- JSON: defaults for new members and other admin settings.
    settings TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  ) STRICT;

  -- Each user is in exactly one team.
  CREATE TABLE team_members (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    joined_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX team_members_team ON team_members(team_id);

  CREATE TABLE team_invites (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    grant_admin INTEGER NOT NULL DEFAULT 0,
    -- The token sealed, so the link can be copied again, and its hash for lookup.
    token TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'revoked')),
    invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX team_invites_team ON team_invites(team_id, state);

  CREATE TABLE team_requests (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (team_id, user_id)
  ) STRICT;

  -- A seat is used from the first sign-in (admin-sso-provisioning.md rule 16).
  ALTER TABLE users ADD COLUMN first_sign_in_at INTEGER;
  UPDATE users SET first_sign_in_at = created_at;

  INSERT INTO teams (id, name, domain, created_at)
    SELECT 'team-' || id, name || '''s team', substr(email, instr(email, '@') + 1), created_at
    FROM users;
  INSERT INTO team_members (user_id, team_id, role, joined_at)
    SELECT id, 'team-' || id, 'admin', created_at FROM users;
  `,
  // 12: directory provisioning over SCIM (docs/specs/admin-sso-provisioning.md)
  `
  CREATE TABLE directory_profiles (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    external_id TEXT,
    -- The SCIM resource as the identity provider last sent it.
    resource TEXT NOT NULL,
    -- Flat attribute name -> text value: analytics filters and policy scopes.
    attributes TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX directory_profiles_team ON directory_profiles(team_id);

  CREATE TABLE scim_tokens (
    team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  ) STRICT;

  -- Set when the directory deactivates the person: no sign-in, no scheduling, no seat.
  ALTER TABLE users ADD COLUMN deactivated_at INTEGER;
  `,
  // 13: analytics: meeting cost salaries and analytics-only seats (docs/specs/analytics-organization.md)
  `
  CREATE TABLE analytics_settings (
    team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
    default_salary INTEGER NOT NULL,
    -- Annual salary per department: JSON object department -> whole currency units.
    salaries TEXT NOT NULL DEFAULT '{}'
  ) STRICT;

  -- The member's calendar counts in analytics; the scheduler never changes it.
  CREATE TABLE analytics_seats (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  ) STRICT;
  `,
  // 14: sso: single sign-on per team, CalDAV calendar grant, paced provisioning
  `
  -- A team's OpenID Connect identity provider (admin-sso-provisioning.md rules 2-5, 9).
  CREATE TABLE sso_configs (
    team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
    issuer TEXT NOT NULL,
    client_id TEXT NOT NULL,
    -- Sealed with the server key.
    client_secret TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'sso_only' CHECK (mode IN ('sso_only', 'sso_and_google')),
    domain_capture INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  ) STRICT;

  -- Each email domain belongs to one team's SSO (edge case 5).
  CREATE TABLE sso_domains (
    domain TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX sso_domains_team ON sso_domains(team_id);

  CREATE TABLE sso_states (
    state TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    code_verifier TEXT NOT NULL,
    nonce TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;

  -- A CalDAV account that can read every member's calendars (rules 12-15).
  CREATE TABLE calendar_grants (
    team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
    server_url TEXT NOT NULL,
    username TEXT NOT NULL,
    -- Sealed password.
    password TEXT NOT NULL,
    -- Calendar home of each person, relative to server_url; {local} and {email} are replaced.
    home_template TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  -- An account attached through a team's grant: read-only, read every 24 hours
  -- until the person's first sign-in (rule 17).
  ALTER TABLE accounts ADD COLUMN grant_team_id TEXT;
  ALTER TABLE accounts ADD COLUMN refreshed_at INTEGER;

  -- People waiting for paced provisioning (rule 10). create_user = 0 only attaches a calendar.
  CREATE TABLE provision_jobs (
    id INTEGER PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    attributes TEXT NOT NULL DEFAULT '{}',
    create_user INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'done', 'failed')),
    error TEXT,
    created_at INTEGER NOT NULL,
    done_at INTEGER
  ) STRICT;
  CREATE INDEX provision_jobs_queue ON provision_jobs(state, id);
  CREATE INDEX provision_jobs_team ON provision_jobs(team_id, create_user, state);
  `,
  // 15: templates: team habit templates, defaults for new members, out-of-office calendars
  `
  -- Habit templates an admin recommends to every member (teams-settings-templates.md rules 3-5).
  CREATE TABLE team_habit_templates (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    -- JSON: {"idealTime":"09:00","minutes":60,"days":[1] or null,"level":3,"hours":"work"}
    fields TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX team_habit_templates_team ON team_habit_templates(team_id);

  -- What a member got from the team defaults on joining (rules 4, 9, 10).
  CREATE TABLE team_onboarding (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    -- JSON copy of the team focus template when the member joined, or NULL.
    focus TEXT,
    focus_state TEXT NOT NULL DEFAULT 'none' CHECK (focus_state IN ('none', 'pending', 'accepted', 'off')),
    welcome_done INTEGER NOT NULL DEFAULT 0,
    joined_at INTEGER NOT NULL
  ) STRICT;

  -- Team out-of-office calendars (teams-ooo-calendar.md).
  CREATE TABLE ooo_calendars (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- The owner's shared calendar that receives the copies.
    calendar_id TEXT REFERENCES calendars(id) ON DELETE SET NULL,
    access_checked_at INTEGER,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX ooo_calendars_team ON ooo_calendars(team_id);

  -- Each team member's access to the target calendar, as last read from the server.
  CREATE TABLE ooo_access (
    ooo_id TEXT NOT NULL REFERENCES ooo_calendars(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    access TEXT NOT NULL CHECK (access IN ('write', 'read', 'none')),
    PRIMARY KEY (ooo_id, user_id)
  ) STRICT;

  -- One row per absence seen: its copy, or 'skip' when it did not count. The
  -- display mode is fixed when the absence is first seen (edge case 6).
  CREATE TABLE ooo_copies (
    ooo_id TEXT NOT NULL REFERENCES ooo_calendars(id) ON DELETE CASCADE,
    -- Source calendar id and event id.
    source TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('skip', 'exact', 'all_day')),
    event_id TEXT,
    -- JSON of the copy as last written, to skip writes that change nothing.
    written TEXT NOT NULL DEFAULT '',
    source_end_ms INTEGER NOT NULL,
    PRIMARY KEY (ooo_id, source)
  ) STRICT;
  `,
  // 16: policies: team policies, the automations they make, agenda templates and actions
  `
  CREATE TABLE team_policies (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('focus_time', 'buffers', 'meeting_agendas', 'fragmentation')),
    name TEXT NOT NULL,
    -- JSON: [] is the whole team; [{"attribute":"department","value":"Engineering"}] matches any rule.
    scope TEXT NOT NULL DEFAULT '[]',
    -- JSON: the goal of the type (docs/specs/teams-policies.md).
    goal TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    -- First time the policy was enabled; the report baseline is the 4 weeks before.
    started_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX team_policies_team ON team_policies(team_id);

  -- A focus goal, buffer or habit that a policy made for a member.
  CREATE TABLE policy_automations (
    policy_id TEXT NOT NULL REFERENCES team_policies(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('focus', 'buffer', 'habit')),
    item_id TEXT NOT NULL,
    -- The member changed it; a new policy goal keeps the member's value.
    personalized INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (policy_id, user_id, key)
  ) STRICT;
  CREATE INDEX policy_automations_user ON policy_automations(user_id);

  -- A member's own choices inside a policy, as JSON (fragmentation flexibility).
  CREATE TABLE policy_choices (
    policy_id TEXT NOT NULL REFERENCES team_policies(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    choices TEXT NOT NULL,
    PRIMARY KEY (policy_id, user_id)
  ) STRICT;

  -- An admin's agenda template for one meeting category; it replaces the built-in one.
  CREATE TABLE agenda_templates (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    body TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (team_id, category)
  ) STRICT;

  -- What an agenda policy did about a meeting without an agenda: a reminder to
  -- the organizer, or a decline for an invited member.
  CREATE TABLE agenda_actions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL,
    policy_id TEXT REFERENCES team_policies(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('reminder', 'declined')),
    state TEXT NOT NULL CHECK (state IN ('open', 'dismissed', 'resolved', 'done')),
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    -- "adjust": a shorter end the organizer may apply, and what became of it.
    proposed_end_ms INTEGER,
    proposal TEXT CHECK (proposal IN ('pending', 'applied', 'kept')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, calendar_id, event_id, kind)
  ) STRICT;
  CREATE INDEX agenda_actions_user ON agenda_actions(user_id, kind, state);
  `,
  // 17: delegation: delegated access, acting sessions, the delegates' change log, API keys
  `
  CREATE TABLE delegates (
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delegate_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, delegate_id)
  ) STRICT;
  CREATE INDEX delegates_delegate ON delegates(delegate_id);

  -- The owner whose account a delegate works in during this session.
  ALTER TABLE sessions ADD COLUMN acting_as TEXT REFERENCES users(id) ON DELETE SET NULL;

  -- Changes made in acting sessions, so the owner sees who made them.
  CREATE TABLE delegate_changes (
    id INTEGER PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_email TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX delegate_changes_owner ON delegate_changes(owner_id, created_at);

  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  ) STRICT;
  CREATE INDEX api_keys_user ON api_keys(user_id);
  `,
  // 18: booking: team and round-robin links, page and team branding, team webhook endpoints
  `
  -- Organizers and round-robin pool members of a link (booking-links-team.md).
  CREATE TABLE booking_link_people (
    link_id TEXT NOT NULL REFERENCES booking_links(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('organizer', 'pool')),
    -- NULL: the person's meeting hours.
    hours_set_id TEXT REFERENCES hours_sets(id) ON DELETE SET NULL,
    required INTEGER NOT NULL DEFAULT 1,
    is_host INTEGER NOT NULL DEFAULT 0,
    preferred INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (link_id, user_id)
  ) STRICT;
  CREATE INDEX booking_link_people_user ON booking_link_people(user_id);
  INSERT INTO booking_link_people (link_id, user_id, kind, hours_set_id, required, is_host)
    SELECT id, user_id, 'organizer', hours_set_id, 1, 1 FROM booking_links;

  ALTER TABLE booking_links ADD COLUMN use_recovery_buffer INTEGER NOT NULL DEFAULT 1;
  -- sameAsGroup, default, none or custom (booking-links-booking-page.md rules 25-31).
  ALTER TABLE booking_links ADD COLUMN branding TEXT NOT NULL DEFAULT 'sameAsGroup';
  ALTER TABLE booking_pages ADD COLUMN branding TEXT NOT NULL DEFAULT 'default';

  -- The host holds the event; the assignee is the round-robin member who took it.
  ALTER TABLE bookings ADD COLUMN host_id TEXT REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE bookings ADD COLUMN assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE bookings ADD COLUMN assigned_at INTEGER;
  UPDATE bookings SET host_id = user_id;

  -- Other organizers and the assignee of a booking. A copy of the event on their
  -- own calendar (calendar_id, event_id), or none when their provider delivers
  -- the invitation; then the booking blocks their time from the database.
  CREATE TABLE booking_participants (
    booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    calendar_id TEXT,
    event_id TEXT,
    PRIMARY KEY (booking_id, user_id)
  ) STRICT;
  CREATE INDEX booking_participants_user ON booking_participants(user_id);

  CREATE TABLE team_branding (
    team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
    -- The starting value for new booking pages: default, none or custom.
    mode TEXT NOT NULL DEFAULT 'default',
    homepage_url TEXT NOT NULL DEFAULT '',
    logo_type TEXT,
    logo BLOB,
    banner_type TEXT,
    banner BLOB,
    updated_at INTEGER NOT NULL
  ) STRICT;

  -- Webhook endpoints belong to the team (integrations-webhooks.md rule 1); user_id is the creator.
  ALTER TABLE webhook_endpoints ADD COLUMN team_id TEXT REFERENCES teams(id) ON DELETE CASCADE;
  UPDATE webhook_endpoints SET team_id = (
    SELECT m.team_id FROM team_members m WHERE m.user_id = webhook_endpoints.user_id
  );
  CREATE INDEX webhook_endpoints_team ON webhook_endpoints(team_id);
  `,
  // Round 3: each stream adds at most one migration, right below its own line.
  // round 3 s1
  // r3 s1: event settings of each automation (JSON, src/shared/event-settings.ts),
  // the library template it came from, and the rank of focus time inside P4.
  `
  ALTER TABLE habits ADD COLUMN event_settings TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE habits ADD COLUMN template_id TEXT;
  ALTER TABLE buffers ADD COLUMN event_settings TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE buffers ADD COLUMN template_id TEXT;
  ALTER TABLE focus_goals ADD COLUMN event_settings TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE focus_goals ADD COLUMN template_id TEXT;
  ALTER TABLE focus_goals ADD COLUMN rank INTEGER NOT NULL DEFAULT 0;
  `,
  // round 3 s2
  // round 3 s3
  // round 3 s4
  // round 3 s5
  // round 3 s6
  // round 3 s7
];
