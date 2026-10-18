# Local stack (Docker)

Runs PostgreSQL, Redis, the API and the web app on your machine.

```bash
cd infrastructure
docker compose up --build
```

- Web app: http://localhost:3000 (driver sign-in at `/login`)
- API: http://localhost:4000/api/v1 (health: http://localhost:4000/health/live)

`migrate` applies the database migrations once and exits; the API starts after it succeeds. Data lives in the `pgdata` volume. To start fresh: `docker compose down -v`.

The web app reaches the API inside the compose network (`http://api:4000`), fixed at build time by `FLEETOS_API_URL`.

The API has no sign-up page yet. Create an account and company through the API, then sign in at `/login` with the company ID:

```bash
curl -c jar.txt -H 'content-type: application/json' \
  -d '{"email":"owner@example.com","password":"correct horse battery","displayName":"Owner"}' \
  http://localhost:4000/api/v1/auth/register
curl -b jar.txt -c jar.txt -H 'content-type: application/json' \
  -d '{"email":"owner@example.com","password":"correct horse battery"}' http://localhost:4000/api/v1/auth/login
curl -b jar.txt -H 'content-type: application/json' -d '{"name":"Demo Co","slug":"demo-co"}' http://localhost:4000/api/v1/tenants
```

The `id` in the last response is the company ID.
