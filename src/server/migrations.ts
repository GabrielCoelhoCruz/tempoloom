// Append-only list. Never edit a migration that has shipped; add a new one.
export const MIGRATIONS: readonly string[] = [
  // 1: identity and the calendar mirror
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    time_zone TEXT NOT NULL DEFAULT 'UTC',
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
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE google_accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    google_sub TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    access_token TEXT,
    access_expires_at INTEGER NOT NULL DEFAULT 0,
    scope TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'reauth_required')),
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX google_accounts_user ON google_accounts(user_id);

  CREATE TABLE calendars (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES google_accounts(id) ON DELETE CASCADE,
    google_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    time_zone TEXT,
    access_role TEXT NOT NULL,
    is_primary INTEGER NOT NULL DEFAULT 0,
    color TEXT,
    -- Busy events on this calendar block time for scheduling.
    check_availability INTEGER NOT NULL DEFAULT 0,
    sync_token TEXT,
    window_start INTEGER,
    window_end INTEGER,
    synced_at INTEGER,
    UNIQUE (account_id, google_id)
  ) STRICT;

  CREATE TABLE events (
    calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    google_id TEXT NOT NULL,
    status TEXT NOT NULL,
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
    PRIMARY KEY (calendar_id, google_id)
  ) STRICT;
  CREATE INDEX events_time ON events(calendar_id, start_ms, end_ms);
  `,
  // 2: managed events written to Google Calendar
  `
  CREATE TABLE managed_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    google_id TEXT,
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
    etag TEXT,
    UNIQUE (user_id, key)
  ) STRICT;
  CREATE INDEX managed_events_source ON managed_events(user_id, kind, source_id);
  CREATE INDEX managed_events_google ON managed_events(calendar_id, google_id);
  `,
];
