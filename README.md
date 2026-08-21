# SnowBeltTech Lead Portal

A multi-tenant lead-management portal for local service businesses (HVAC, plumbing, roofing, landscaping, cleaning, auto repair, property maintenance). Each customer business signs in and sees only its own leads; SnowBeltTech operates a platform-administrator account for support and maintenance.

## Current status

**Foundation + local tenancy schema with RLS + trusted ingestion database boundary (Batches 1–2A).** The tenancy tables (`businesses`, `profiles`, `business_memberships`, `integration_sources`, `leads`), the operational `ingestion_events` ledger, an internal lead-number allocator and the privileged `ingest_lead_event` RPC exist as reproducible Supabase migrations with RLS enabled and forced, least-privilege grants, defensive immutability triggers, deterministic synthetic seed data and a pgTAP test suite — all running **only on a local Docker Supabase stack**.

**No hosted Supabase project is connected** (no `supabase login`/`link`, no remote database URL). No Next.js application, authentication UI, ingestion API, n8n change or production integration exists yet. The only other committed artifact is a sanitized reference copy of the currently live n8n workflow.

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
3. **Trusted ingestion** — database boundary implemented and verified locally (`ingest_lead_event`); the authenticated HTTP endpoint in front of it is not built yet.
4. **Customer portal** — auth, lead workspace MVP.
5. **Platform administration** — cross-tenant operations.
6. **n8n cutover** — replace Google Sheets, add delivery callbacks (dev-cloned workflow, synthetic submissions, reconciliation, controlled cutover; Sheets retained only as an archived backup).
7. **Production hardening** — custom SMTP, MFA, backups, deployment.

## Trusted ingestion boundary (database side)

`public.ingest_lead_event(p_source_kind, p_source_external_id, p_source_event_id, p_payload jsonb)` is a `SECURITY DEFINER` RPC executable **only by `service_role`** (revoked from `PUBLIC`, `anon`, `authenticated`). It performs one atomic operation: resolve the tenant **solely** from the registered `integration_sources (kind, external_id)` row (active source, active business — payload `business_id` is rejected), deduplicate on `business_id + source + complete source_event_id`, allocate a per-business `INQ-<year>-<nnnn>` number, and create the lead plus an `ingestion_events` row. It returns one row: `outcome` (`lead_created` | `duplicate_lead` | `filtered` | `duplicate_filtered`), `should_notify` (true **only** for `lead_created`), `customer_sms_allowed`, `business_id`, `lead_id`, `lead_number`, `ingestion_event_id`, `attempt_count`.

Event identity: website submissions must carry a **stable submission ID generated once upstream and reused on retries** (the live workflow's per-execution random inquiry ID is not a replay key). Voice calls use the **complete Vapi call ID** as both `call_id` and `source_event_id`; a truncated suffix is rejected by constraint. Voice calls that are not `is_lead && call_classification = 'legitimate_lead'` are recorded as `filtered` ingestion events with sanitized metadata and no lead. Voice SMS consent is unsupported and must be `false`; website SMS consent requires complete evidence (text, version, source, timestamp).

Not built yet: the authenticated HTTP endpoint that calls this RPC, any hosted Supabase project, the live n8n cutover, and notification (SMS) delivery.

## About `n8n/reference/current-live-workflow.sanitized.json`

A structure-preserving, **sanitized** copy of the live production workflow, committed for review purposes only. All credentials, phone numbers, sheet IDs, webhook paths, and instance identifiers are replaced with `REDACTED_*` placeholders, and it is marked inactive. It is **not importable as a production replacement** without full reconfiguration. The raw export remains outside version control by an explicit `.gitignore` rule.
