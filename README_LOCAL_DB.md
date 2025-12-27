# Local Postgres (required)

Your server is configured to use Postgres via `DATABASE_URL`.

## Option A (recommended): Docker
1. Install Docker Desktop.
2. From the project root (same folder as `docker-compose.yml`):

```bash
docker compose up -d
```

3. In `server/.env` use:

```env
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/spectatore
```

4. Initialise tables (first time):

```bash
cd server
npm run db:init
```

## Option B: Local Postgres install (Windows)
- Ensure the Postgres service is running and listening on port 5432.
- Create the database named `spectatore` if it doesn't exist.
