# Pit Wall Infrastructure

## Local Services

Pit Wall v2 uses PostgreSQL for relational game state and Redis for short-lived OpenF1 cache, live polling cache, leaderboard materialization, and future push/lock jobs.

```bash
npm install
docker compose up -d
npm run db:migrate
npm run db:seed
npm run dev
```

Services:

| Service | Local URL | Purpose |
|---|---|---|
| Backend API | http://localhost:3000/api | Express API |
| Frontend | http://localhost:4200 | Angular SSR app |
| PostgreSQL | localhost:5432 | Users, leagues, teams, predictions, scores |
| Redis | localhost:6379 | OpenF1 cache, leaderboard/live-session foundation |

## Environment

Required production variables:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Railway PostgreSQL connection string |
| `REDIS_URL` | Railway Redis connection string |
| `FRONTEND_URL` | Public frontend origin for CORS/session cookies |
| `SESSION_SECRET` | Secure Express session secret |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth |
| `OPENF1_BASE_URL` | Defaults to `https://api.openf1.org/v1` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web Push notification foundation |

## CI/CD

GitHub Actions runs:

1. `npm ci`
2. `npm run db:migrate`
3. `npm run db:seed`
4. `npm test`
5. `npm run build`

Railway uses `railway.json`:

1. Build: `npm ci && npm run build`
2. Start: `npm run db:migrate && npm run db:seed && npm run start -w backend`

Provision Railway PostgreSQL and Redis plugins, then set the variables above.

## Database Verification Gate

Before adding API endpoints against a new schema slice, run the database path against a real PostgreSQL instance:

```bash
docker compose up -d
npm run db:migrate
npm run db:seed
```

Then verify the invariants that protect league-season manager creation:

```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename IN ('seasons', 'game_sessions')
  AND indexdef LIKE '%WHERE%';

SELECT name, base_motor, base_aero, base_grip, base_durability, base_budget
FROM constructors;
```

## Commissioner Model

Leagues use `owner_user_id` as the commissioner/creator pointer. `league_members.role` controls membership permissions with `admin` and `player` roles. Commissioner-only actions, such as starting a league season, should require either `leagues.owner_user_id = current_user.id` or an `admin` league member row.
