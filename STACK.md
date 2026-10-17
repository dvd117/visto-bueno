# Vite + Hono stack pack

This pack creates a Vite React TypeScript frontend and a Hono Node server in one container.

- `src/server.ts` serves the built `dist/` frontend and exposes liveness-only `GET /health` with `{ ok: true }`.
- Tests use Vitest. `npm run build` typechecks the Vite app and server before building the frontend.
- Docker runs as a non-root user on port 3000, with an image healthcheck on `/health`.
- Production compose routes `PUBLIC_HOST` (default `<app>.aragort.com`) through Traefik.
- This pack is database-free. Add a database service and application code separately when needed.

The server runs with `tsx` in production so the Docker image copies only the server entry and built frontend into its runtime stage.

## Routing and preview

`docker-compose.yml` takes its Traefik names from env with no defaults: `ROUTER_ID` and `PUBLIC_HOST` (production's values are in `.env.example`), plus `ROBOTS_TAG`, empty in production. That lets a preview environment run the same file: `/dokploy --preview` creates a `dev` branch and a Dokploy `dev` environment that deploys it to its own host with `ROUTER_ID=<app>-dev` and `ROBOTS_TAG=noindex, nofollow`. CI already runs on pushes to `dev`; `ship` stays main-only.

Rule for application code: every external side effect (email, newsletter, payments, webhooks) gets a `<PROVIDER>_DRY_RUN=1` switch that validates input and then skips the call, with a test. A preview runs with it on and dummy credentials, so nothing it does reaches real people.
