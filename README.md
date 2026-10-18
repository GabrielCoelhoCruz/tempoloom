# Tempoloom

Tempoloom is a self-hostable calendar planner. You give it tasks, habits and
focus-time goals. It finds time for them around your meetings, writes the
blocks into your Google Calendar, and moves them when your week changes.

Status: early development. See [docs/parity.md](docs/parity.md) for the
feature list and the status of each feature.

## Goals

- Fast: small client bundle, low interaction latency, and a scheduler that
  plans a full week in milliseconds. Measurements: [docs/performance.md](docs/performance.md).
- Self-hostable: one Node.js process and one SQLite file.
- Deterministic: the same input always gives the same schedule.
- Open: AGPL-3.0.

## Requirements

- Node.js 24.11 or later
- A Google Cloud OAuth client (type "Web application") with the redirect URI
  `<BASE_URL>/auth/google/callback`

## Run it

```bash
npm ci
npm run build
export SECRET_KEY="$(openssl rand -base64 32)"   # keep this value; it encrypts tokens
export GOOGLE_CLIENT_ID=...
export GOOGLE_CLIENT_SECRET=...
export BASE_URL=http://localhost:8787
npm start
```

Open `BASE_URL` and sign in with Google.

### With Docker

```bash
cp .env.example .env    # fill in the values
docker compose up -d
```

The database lives in the `tempoloom-data` volume. Back up that volume and
keep `SECRET_KEY`: without it, the stored Google tokens cannot be read.

## Develop

```bash
npm run typecheck
npm run lint
npm test            # scheduler and unit tests
npm run test:e2e    # end-to-end tests; see tests/e2e/README.md
```

Design decisions are in [docs/adr](docs/adr). Feature behavior is defined in
[docs/specs](docs/specs). Code is written from those specs; see
[docs/clean-room.md](docs/clean-room.md).

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
