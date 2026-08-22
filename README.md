# SnowBeltTech Lead Portal

A multi-tenant lead-management portal for local service businesses (HVAC, plumbing, roofing, landscaping, cleaning, auto repair, property maintenance). Each customer business signs in and sees only its own leads; SnowBeltTech operates a platform-administrator account for support and maintenance.

## Current status

**Foundation + local tenancy schema with RLS + trusted ingestion database boundary + a minimal Next.js application with the authenticated n8n ingestion endpoint (Batches 1–2B).** The tenancy tables (`businesses`, `profiles`, `business_memberships`, `integration_sources`, `leads`), the operational `ingestion_events` ledger, an internal lead-number allocator and the privileged `ingest_lead_event` RPC exist as reproducible Supabase migrations with RLS enabled and forced, least-privilege grants, defensive immutability triggers, deterministic synthetic seed data and a pgTAP test suite — all running **only on a local Docker Supabase stack**.

**No hosted Supabase project is connected** (no `supabase login`/`link`, no remote database URL). The Next.js application exists locally with exactly one server-to-server endpoint; customer authentication, dashboards, platform administration, Twilio callbacks, the live n8n cutover and any production integration do not exist yet. The only other committed artifact is a sanitized reference copy of the currently live n8n workflow.

## Local database development

Verified prerequisites: Node 24, pnpm 11, Docker Desktop (daemon running). The Supabase CLI is a pinned dev dependency (`supabase@2.115.0` in `pnpm-lock.yaml`); no global install is required.

| Command | What it does |
|---|---|
| `pnpm install` | installs the pinned Supabase CLI |
| `pnpm run db:start` | starts the local stack (db, auth, rest, kong only; studio/storage/realtime/mail are disabled in `supabase/config.toml`) |
| `pnpm run db:reset` | recreates the local database from `supabase/migrations/*` and `supabase/seed.sql` |
| `pnpm run db:test` | runs the pgTAP suite in `supabase/tests/database/` (personas switch to the `authenticated`/`anon` roles with JWT claims) |
| `pnpm run db:concurrency` | real parallel-session proof that duplicate deliveries yield one lead and distinct events get distinct numbers (synthetic data, cleans up) |
| `pnpm run db:lint` | `supabase db lint --local --level error` |
| `pnpm run db:migrations` | lists local migration status |
| `pnpm run db:stop` | stops the local stack |

The local stack publishes ports 54321 (API) and 54322 (Postgres) through Docker Desktop. **Docker Desktop on Windows may publish these ports on broader interfaces than loopback** (the CLI's port mapping cannot pin a host IP); this is an acknowledged, temporary local-development limitation, not a property of the hosted production Supabase project, which is entirely separate. Therefore: use synthetic development data only (the seed contains `.invalid` accounts and fictitious numbers), develop on a trusted network with the host firewall enabled, and stop the stack (`pnpm run db:stop`) when not in use. Local keys are never committed. Public signup is disabled in the local auth config.

## Target users

- **Customer businesses** — local service companies receiving website-form and AI voice-call inquiries.
- **SnowBeltTech (platform administrator)** — operates the platform, onboards businesses, monitors ingestion and SMS delivery.

## High-level architecture (planned)

- Modular monolith: one Next.js application serving the customer portal and platform administration at `portal.snowbelttech.com`.
- Supabase Postgres as the sole lead system of record; Supabase Auth for sign-in; mandatory PostgreSQL Row Level Security for tenant isolation.
- The existing shared self-hosted n8n (`n8n.snowbelttech.com`) remains the private automation layer, ingesting website-form submissions and Vapi end-of-call reports, then notifying via SnowBeltTech-managed Twilio.
- Customers never access n8n, Supabase administration, Twilio, or infrastructure.

## Relationship to `service_CRM`

`service_CRM` is a separate premium product: a fully isolated, single-tenant CRM installed per customer. This Lead Portal is the shared multi-tenant offering. **One system of record per business** — a business uses the Lead Portal or a dedicated CRM install, never both. The CRM repository is studied for proven designs and tests but is not modified from this project.

## Planned components

- Tenancy schema (`businesses`, `profiles`, `business_memberships`, `integration_sources`, `leads`, `messages`, `lead_activities`, `ingestion_events`) with forced RLS.
- Trusted ingestion boundary for n8n (idempotent lead creation keyed on business + source + full source event ID).
- Customer portal: lead list/detail, status, notes, follow-ups, CSV export.
- Platform administration: business switcher, cross-tenant views, invitations, ingestion/SMS health.
- n8n cutover from Google Sheets to Supabase, with Twilio delivery-status callbacks.

## Security principles

- Tenant isolation enforced in the database (RLS enabled and forced), not in the frontend.
- Tenant IDs are never trusted from browsers, forms, or webhook bodies — always resolved server-side from registered integration sources or authenticated membership.
- Leads are stored durably before any notification is attempted; Twilio acceptance is not treated as delivery.
- No service-role or secret keys in browser code; no secrets in `NEXT_PUBLIC_*`; invitation-only user creation; platform-admin MFA planned.

## Roadmap

1. **Foundation** — this repository (done).
2. **Schema/RLS** — tenancy tables, policies, isolation proofs (implemented and verified locally).
3. **Trusted ingestion** — database boundary (`ingest_lead_event`) and the authenticated local HTTP endpoint implemented and verified locally.
4. **Customer portal** — auth, lead workspace MVP.
5. **Platform administration** — cross-tenant operations.
6. **n8n cutover** — replace Google Sheets, add delivery callbacks (dev-cloned workflow, synthetic submissions, reconciliation, controlled cutover; Sheets retained only as an archived backup).
7. **Production hardening** — custom SMTP, MFA, backups, deployment.

## Local application (Next.js)

The application runs only on the loopback interface. Sequence:

1. `pnpm install --frozen-lockfile`
2. `pnpm run db:start` — local Supabase (see the Docker networking note above; stop it when idle)
3. `pnpm run env:local` — reads the running local stack, generates a random 64-hex n8n ingestion token and writes the git-ignored `.env.local` (refuses non-local Supabase URLs, refuses to overwrite unless `-- --force`, never prints secrets)
4. `pnpm dev` (or `pnpm build && pnpm start`) — serves `http://127.0.0.1:3000` only
5. `pnpm typecheck`, `pnpm lint`, `pnpm test` (unit), `pnpm run test:integration` (spawns the production server and drives the real HTTP → Supabase path; needs steps 2–3 and a prior `pnpm build`)

Configuration (`.env.example` documents placeholders): `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are **browser-safe public values** (the anon/publishable key is not a secret). `SUPABASE_SERVICE_ROLE_KEY` and `N8N_INGEST_TOKEN` are **server-only secrets**: they are read exclusively inside `src/lib/server/*` (modules marked `server-only`), are never prefixed `NEXT_PUBLIC_`, and `.env.local` is ignored by git. Never confuse the anon key with the service-role key.

### Internal ingestion endpoint

`POST /api/internal/ingest` — the only route. It is a server-to-server endpoint for n8n: `Authorization: Bearer <N8N_INGEST_TOKEN>` (constant-time comparison; missing, malformed, wrong or multiple bearer values → opaque `401 {"error":"unauthorized"}`), JSON only, 64 KiB body cap (streamed bytes counted, so chunked requests are capped too), no cookies, no CORS, never cached, Node.js runtime. After validation it calls the privileged database RPC `ingest_lead_event` through a server-only service-role client; the business is resolved **only** from the registered integration source — a `business_id` anywhere in the request is rejected.

```json
{
  "source_kind": "website_form",
  "source_external_id": "site-alpha-synthetic",
  "source_event_id": "stable-form-submission-0001",
  "payload": {
    "contact_name": "Synthetic Customer",
    "email": "customer@example.invalid",
    "phone_e164": "+15550100001",
    "requested_service": "Furnace inspection",
    "sms_consent": false
  }
}
```

`curl -X POST http://127.0.0.1:3000/api/internal/ingest -H "Authorization: Bearer <token-from-.env.local>" -H "Content-Type: application/json" --data @request.json`

Responses: `201` `lead_created` (with `should_notify: true`), `200` for `duplicate_lead` / `filtered` / `duplicate_filtered` (always `should_notify: false`); body is `{outcome, should_notify, customer_sms_allowed, lead_id, lead_number}` only — never `business_id`, customer details or database errors. Errors: `401` auth, `405` method, `415` content type, `413` size, `400` malformed JSON, `422 {"error":"invalid_request","issues":[{path,message}]}` (paths only, never values), `403 {"error":"source_not_accepted"}` for unknown/inactive sources and suspended/archived businesses alike, `503` database unavailable, `500` generic. Voice events use `source_kind` `vapi_assistant` or `vapi_phone_number` with `payload.call_id` equal to the complete `source_event_id`.

## Trusted ingestion boundary (database side)

`public.ingest_lead_event(p_source_kind, p_source_external_id, p_source_event_id, p_payload jsonb)` is a `SECURITY DEFINER` RPC executable **only by `service_role`** (revoked from `PUBLIC`, `anon`, `authenticated`). It performs one atomic operation: resolve the tenant **solely** from the registered `integration_sources (kind, external_id)` row (active source, active business — payload `business_id` is rejected), deduplicate on `business_id + source + complete source_event_id`, allocate a per-business `INQ-<year>-<nnnn>` number, and create the lead plus an `ingestion_events` row. It returns one row: `outcome` (`lead_created` | `duplicate_lead` | `filtered` | `duplicate_filtered`), `should_notify` (true **only** for `lead_created`), `customer_sms_allowed`, `business_id`, `lead_id`, `lead_number`, `ingestion_event_id`, `attempt_count`.

Event identity: website submissions must carry a **stable submission ID generated once upstream and reused on retries** (the live workflow's per-execution random inquiry ID is not a replay key). Voice calls use the **complete Vapi call ID** as both `call_id` and `source_event_id`; a truncated suffix is rejected by constraint. Voice calls that are not `is_lead && call_classification = 'legitimate_lead'` are recorded as `filtered` ingestion events with no lead and an allow-listed, machine-readable metadata set only (`filter_reason`, `is_lead`, `call_classification`, `review_recommended`, `ended_reason` — never free text or contact data). Supplied timestamps must carry an explicit timezone (`Z` or `±HH:MM`); `source_event_id` is stored exactly as received (surrounding whitespace is rejected). Voice SMS consent is unsupported and must be `false`; website SMS consent requires complete evidence (text, version, source, timestamp).

Not built yet: any hosted Supabase project, the live n8n cutover, customer authentication/dashboards, and notification (SMS) delivery.

## About `n8n/reference/current-live-workflow.sanitized.json`

A structure-preserving, **sanitized** copy of the live production workflow, committed for review purposes only. All credentials, phone numbers, sheet IDs, webhook paths, and instance identifiers are replaced with `REDACTED_*` placeholders, and it is marked inactive. It is **not importable as a production replacement** without full reconfiguration. The raw export remains outside version control by an explicit `.gitignore` rule.
