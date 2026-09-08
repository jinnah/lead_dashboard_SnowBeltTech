# Hostinger VPS deployment

The production application is a single Next.js container. Supabase remains a
separate hosted service and is the system of record. The container publishes
port 3000 on VPS loopback only; the VPS's existing reverse proxy terminates TLS
for `portal.snowbelttech.com` and forwards to `http://127.0.0.1:3000`.

## Required production dependencies

- A hosted Supabase production project with every migration in
  `supabase/migrations/` applied in order.
- Supabase Auth public signup disabled, the Site URL set to
  `https://portal.snowbelttech.com`, and that same origin allowed as a redirect
  URL.
- Production SMTP configured and tested before customer invitations or password
  recovery are enabled operationally.
- DNS A/AAAA records for `portal.snowbelttech.com` pointing to the VPS.
- The existing VPS reverse proxy identified before making changes. Do not bind a
  second proxy to ports 80/443 or alter the working n8n route.

## Production environment

Create `/opt/snowbelttech-portal/.env.production` on the VPS with mode `0600`.
Never commit or print its values.

```dotenv
APP_BASE_URL=https://portal.snowbelttech.com
NEXT_PUBLIC_SUPABASE_URL=https://PROJECT_REF.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=production-publishable-or-anon-key
SUPABASE_URL=https://PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=production-service-role-key
N8N_INGEST_TOKEN=64-or-more-random-hex-characters
```

The `NEXT_PUBLIC_*` values are compiled into the browser bundle, so rebuild the
image whenever they change. The service-role key and ingestion token are
server-only secrets.

Generate the ingestion token locally without printing it to shell history:

```bash
openssl rand -hex 32
```

Store that same token in the n8n credential used for
`POST https://portal.snowbelttech.com/api/internal/ingest` only after the portal
is healthy. Do not modify the live n8n workflow during the initial deployment.

## First deployment

Before changing the server, record the current proxy and container state:

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
docker network ls
sudo ss -lntp
```

Then install the application in its own directory and build it:

```bash
sudo install -d -m 0755 /opt/snowbelttech-portal
cd /opt/snowbelttech-portal
# Clone or pull the repository here, then create .env.production with mode 0600.
docker compose --env-file .env.production -f compose.production.yaml config --quiet
docker compose --env-file .env.production -f compose.production.yaml build --pull
docker compose --env-file .env.production -f compose.production.yaml up -d
docker compose --env-file .env.production -f compose.production.yaml ps
curl --fail --silent --show-error http://127.0.0.1:3000/login >/dev/null
```

Configure the existing reverse proxy with:

- hostname: `portal.snowbelttech.com`
- upstream: `http://127.0.0.1:3000`
- WebSocket support: enabled
- TLS: a valid automatically renewed Let's Encrypt certificate
- forwarded headers: `Host`, `X-Real-IP`, `X-Forwarded-For`, and
  `X-Forwarded-Proto`

If the existing proxy is itself a Docker container, loopback inside that
container is not the VPS loopback. Connect the portal to the proxy's existing
external Docker network and route to `portal:3000`; remove the host `ports`
mapping only after that container-to-container route is verified.

## Verification

```bash
docker compose --env-file .env.production -f compose.production.yaml ps
docker compose --env-file .env.production -f compose.production.yaml logs --tail=100 portal
curl --fail --silent --show-error https://portal.snowbelttech.com/login >/dev/null
```

Verify manually that sign-in, sign-out, an authorized dashboard view, an
unauthorized tenant view, and password recovery behave as expected. Verify an
invitation email only after production SMTP is configured. Keep the live n8n
workflow unchanged until a separate ingestion cutover is reviewed.

## Routine update and rollback

Before an update, record the currently deployed Git commit and image ID. Pull
only a reviewed commit, rebuild, and replace the portal container:

```bash
git rev-parse HEAD
docker image inspect snowbelttech-lead-portal:local --format '{{.Id}}'
git pull --ff-only
docker compose --env-file .env.production -f compose.production.yaml build --pull
docker compose --env-file .env.production -f compose.production.yaml up -d
```

For rollback, check out the previously recorded commit, rebuild the image, and
run `docker compose ... up -d` again. Database migrations require their own
reviewed rollback plan; do not reverse production migrations ad hoc.
