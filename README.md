# SnowBeltTech Lead Portal

A multi-tenant lead-management portal for local service businesses (HVAC, plumbing, roofing, landscaping, cleaning, auto repair, property maintenance). Each customer business signs in and sees only its own leads; SnowBeltTech operates a platform-administrator account for support and maintenance.

## Current status

**Foundation + local tenancy schema with RLS + trusted ingestion database boundary + Next.js application with the authenticated n8n ingestion endpoint and real Supabase Auth sign-in with customer and administrator dashboards, audited lead workflow and assignment, and audited platform-administrator business onboarding (Batches 1–4A).** The tenancy tables (`businesses`, `profiles`, `business_memberships`, `integration_sources`, `leads`), the operational `ingestion_events` ledger, an internal lead-number allocator and the privileged `ingest_lead_event` RPC exist as reproducible Supabase migrations with RLS enabled and forced, least-privilege grants, defensive immutability triggers, deterministic synthetic seed data and a pgTAP test suite — all running **only on a local Docker Supabase stack**.

**No hosted Supabase project is connected** (no `supabase login`/`link`, no remote database URL). The Next.js application runs locally with real Supabase Auth sign-in, a customer lead workspace (status updates, follow-up scheduling in the business timezone, append-only notes, owner/manager lead assignment, immutable activity timeline), a platform-administrator area (read-only lead inspection plus audited business onboarding, suspend/reactivate and trusted integration-source registration), and the server-to-server ingestion endpoint. Customer provisioning is invitation-only and fully local (administrator invitations, membership management, invitation acceptance with initial password setup, all against the local Supabase Auth stack and its mail catcher), and local password recovery exists (generic non-enumerating forgot-password flow through the same mail catcher). The customer workspace has database-side lead search, pagination and a role-restricted CSV export. MFA, Twilio callbacks, the live n8n cutover and any production integration (hosted Supabase, production SMTP, deployment) do not exist yet. The only other committed artifact is a sanitized reference copy of the currently live n8n workflow.

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
4. **Customer portal** — real Supabase Auth sign-in, customer dashboard with audited status/follow-up/notes/assignment, database-side search and pagination, owner/manager CSV export, local password recovery, read-only admin overview and lead inspection (implemented locally).
5. **Platform administration** — business creation, suspend/reactivate, integration-source registration/activation, invitation-only customer provisioning and membership management with immutable operations and access ledgers (implemented locally); custom SMTP and MFA are later production batches.
6. **n8n cutover** — replace Google Sheets, add delivery callbacks (dev-cloned workflow, synthetic submissions, reconciliation, controlled cutover; Sheets retained only as an archived backup).
7. **Production hardening** — custom SMTP, MFA, backups, deployment.

## Local application (Next.js)

The application runs only on the loopback interface. Sequence:

1. `pnpm install --frozen-lockfile`
2. `pnpm run db:start` — local Supabase (see the Docker networking note above; stop it when idle)
3. `pnpm run env:local` — reads the running local stack, generates a random 64-hex n8n ingestion token and writes the git-ignored `.env.local` (refuses non-local Supabase URLs, refuses to overwrite unless `-- --force`, never prints secrets)
4. `pnpm dev` (or `pnpm build && pnpm start`) — serves `http://127.0.0.1:3000` only
5. `pnpm typecheck`, `pnpm lint`, `pnpm test` (unit), `pnpm run test:integration` (spawns the production server; drives the real HTTP → Supabase ingestion path and real Supabase Auth sign-in/dashboard sessions; needs steps 2–3, a prior `pnpm build`, and a freshly reset database — `pnpm run db:reset` — because the suites assert absolute seeded counts)

Configuration (`.env.example` documents placeholders): `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are **browser-safe public values** (the anon/publishable key is not a secret). `SUPABASE_SERVICE_ROLE_KEY` and `N8N_INGEST_TOKEN` are **server-only secrets**: they are read exclusively inside `src/lib/server/*` (modules marked `server-only`), are never prefixed `NEXT_PUBLIC_`, and `.env.local` is ignored by git. Never confuse the anon key with the service-role key.

### Signing in locally (synthetic accounts)

After `pnpm run db:start`, `pnpm run env:local` and `pnpm dev` (or `pnpm build && pnpm start`), open `http://127.0.0.1:3000`. The seed provides local-only accounts, all with the password `local-seed-only` (defined in `supabase/seed.sql`; `.invalid` addresses never receive mail):

| Account | Role | Lands on |
|---|---|---|
| `owner-a@example.invalid`, `manager-a@example.invalid`, `staff-a@example.invalid` | Business A (Alpha HVAC) members | `/dashboard` |
| `owner-b@example.invalid` | Business B (Bravo Plumbing) owner | `/dashboard` |
| `platform-admin@example.invalid` | Platform administrator | `/admin` |
| `former-staff-a@example.invalid` | inactive membership | `/no-access` |

Lead workflow (customers): `POST /api/leads/<id>/actions` is a same-site form endpoint with five allow-listed actions — `set_status` (the seven lead statuses only), `set_follow_up` (`date` + `time` interpreted in the lead's business timezone; a DST-nonexistent time is rejected, an ambiguous fall-back time resolves to the first occurrence), `clear_follow_up`, `add_note` (`note` ≤ 2,000 chars + a per-render `request_id` UUID for idempotent resubmission), `set_assignee` (below). Unexpected fields are rejected, the lead must be visible through RLS, and every outcome redirects back to the lead page with an allow-listed result code (no submitted value appears in URLs or logs). Status/follow-up changes are audited by a database trigger into the append-only `lead_activities` ledger (actor = `auth.uid()`, same transaction); notes go through the `add_lead_note` RPC (authenticated-only, actor from `auth.uid()`, idempotent per request id). Assignment: active **owners and managers** may assign a lead to any active member (owner, manager or staff) of the same active business, or unassign it, through the `set_lead_assignee` RPC (authenticated-only, caller from `auth.uid()`, lead row locked before authorization, opaque rejection for unknown/foreign leads and invalid assignees); staff see assignments read-only; platform administrators remain read-only — the RPC itself rejects a caller whose profile carries a platform role, even if that account also holds an active owner/manager membership, and the shared authorization helper `private.active_business_ids()` likewise excludes platform-role profiles, so a dual-role administrator gains no customer mutation rights anywhere (status, follow-up and notes included) even through direct database requests. The `set_assignee` action requires exactly one `assignee_id` field: a member UUID assigns, an explicitly empty value unassigns, and a missing, duplicated or whitespace-only field is rejected (`invalid_assignee`) rather than interpreted. Assignment is a **workload filter** (`?assignment=mine|unassigned|<active member id>`), never a visibility boundary — every active member still sees every lead of the business. Assignment changes are recorded as immutable `assignment_changed` activities (actor, old/new assignee UUIDs and display-name snapshots). Customers can read but never update or delete activities; activity rows are immutable for every role. `actor_id` is a historical actor identifier captured from `auth.uid()` (not a foreign key), so history — including the actor's UUID and display-name snapshot — is preserved unchanged if an account is later removed. Follow-up audit values are fixed-width microsecond UTC (`YYYY-MM-DDTHH:MM:SS.ffffffZ`). Platform administrators can inspect any lead and its timeline at `/admin/leads/<id>` (read-only). Form bodies are streamed with hard caps: 4 KiB for login, 16 KiB for lead and administrator actions (chunked requests included).

Customer roles (the header shows the effective, server-derived role for the selected business — Owner / Manager / Staff):

| Capability | Owner | Manager | Staff | Platform admin |
|---|---|---|---|---|
| See all business leads, search, filter, open/update leads, notes, follow-ups | ✔ | ✔ | ✔ | read-only |
| Assign leads, CSV export | ✔ | ✔ | — | — |
| **Team & access** (`/dashboard/team`): invite Manager/Staff, change Manager↔Staff, deactivate/reactivate | ✔ | — | — | via `/admin` |
| Provision/modify Owners, change own membership, business lifecycle, integration sources | — | — | — | ✔ |

Owners manage their team through the SAME hardened invitation/membership RPCs the administrator uses (one shared database authorization gate; owner calls are additionally restricted to Manager/Staff targets, never themselves, never other owners, with the exact-provenance invitation compensation unchanged). Owners can read only their own business's pending invitations; the access ledger stays administrator-only.

Customer provisioning (invitation-only; public signup stays disabled in `supabase/config.toml`): from `/admin/businesses/<id>` an administrator manages **Team members** (role changes among owner/manager/staff, activate/deactivate — deactivation revokes dashboard and database access on the next request; a business can never lose its last effective active owner) and **Invitations** (email + display name + role; an unprovisioned business must invite its owner first; one live invitation per email; suspended/archived businesses cannot invite). Sending an invitation coordinates two boundaries fail-closed: the database rows change through the administrator's ordinary session (`admin_prepare_customer_invitation` → `admin_mark_customer_invitation_sent`, with `admin_mark_customer_invitation_failed` / `admin_revoke_customer_invitation` as compensation), while the actual Supabase Auth invite email goes through a dedicated **server-only Auth Admin module** (`src/lib/server/supabase-auth-admin.ts`, service-role key, exactly three reviewed Auth Admin operations, never imported by pages or customer routes, never used for table access). Locally the email lands in Supabase's mail catcher (`[local_smtp]`, web/API on 54324 — nothing leaves the machine); the template links to `/auth/confirm?token_hash=…&type=invite`, which verifies the token server-side (`verifyOtp`, ordinary cookie session), calls `accept_customer_invitation()` (bound to `auth.uid()` and the Auth email inside the database; creates the profile + active membership atomically; idempotent on replay; opaque rejection for revoked/expired/mismatched invitations) and then `/account/setup` sets the initial password (≥ 12 characters, through the user's own session only). Revocation flips the database first, then removes the still-unaccepted Auth account, so a captured link can never provision access afterwards. A failed delivery compensates the same way: the invitation is marked `failed` first, and if the Auth stack left the just-created unaccepted account behind, the database positively identifies it (exact email, created by this attempt, no profile/membership, bound to no other invitation) and the coordinator deletes exactly that account — so the email is immediately reinvitable, verified end-to-end without any test-side database cleanup. Archived businesses are non-operable for membership administration at the database boundary itself (direct RPC calls are rejected, not just hidden in the UI); suspended businesses remain administrable while their members stay locked out. Note the local stack raises the Supabase email rate limit (`[auth.rate_limit] email_sent = 200`) strictly for the synthetic mail catcher — this is a LOCAL-TEST value, no hosted project is linked, and hosted production rate limits require their own explicit review. Invitations are visible to administrators and (for their own business only) its active owners; the immutable `customer_access_events` ledger (roles/statuses and historical UUIDs only — never emails or tokens) remains visible to administrators only.

Lead search, pagination and CSV export (customers): `/dashboard` has a search field covering the lead number, contact name, email, normalized phone number and requested service — never raw ingestion payloads, source event IDs, consent text, notes/activity bodies, internal metadata or other businesses. Search text is trimmed, whitespace-collapsed and bounded at 120 characters; lead-number and phone searches tolerate common punctuation and partial normalized values. Search and every filter (status, source, assignment, allow-listed newest/oldest sort) execute in PostgreSQL through the `search_leads` RPC — **`SECURITY INVOKER`**, executable by `authenticated` only, so every row is read under the caller's own forced-RLS session and a foreign or unknown business id yields zero rows and zero counts; user input is passed only as RPC parameters (never interpolated into PostgREST filter grammar), so metacharacters match literally or not at all. Results paginate database-side in fixed pages of 50 with a deterministic total order (`created_at`, then lead UUID — equal timestamps can never duplicate or skip rows), a database-computed match count, and Previous/Next links that preserve the normalized parameters; invalid page/sort/search values fall back safely. Summary cards always describe the whole selected business (labelled as such), not the current search page. `GET /api/leads/export` downloads every matching lead as UTF-8 RFC 4180 CSV (BOM + CRLF; fixed headers: Lead Number, Submitted At UTC, Contact Name, Phone, Email, Requested Service, Source, Status, Urgency, Assigned To, Follow Up At UTC, Review Recommended) using **exactly the same normalized filters** as the dashboard, fetched in stable keyset batches. Only active **owners and managers** of the selected active business may export (server-enforced — staff keep full visibility and search but get 403 on the endpoint; platform administrators remain read-only and have **no export in this batch**; unknown/foreign business selections are an opaque 404). Exports refuse — without truncating — above **25,000 matching rows** (`export_too_large`; narrow the search or filters). Cells never contain UUIDs, source event IDs, payloads, consent text, notes or internal metadata; NUL bytes are stripped and spreadsheet formula prefixes (`=`, `+`, `-`, `@`, including whitespace-prefixed variants and `+`-prefixed phone numbers) are neutralized; former members export as the neutral former-member label. The response is `Content-Disposition: attachment` with a fixed filename (business slug + UTC date only), `private, no-store` and `nosniff` — no query-controlled value ever reaches headers.

Password recovery (local only): `/login` links to the public `/forgot-password` page. `POST /api/auth/password-reset/request` is same-site, urlencoded-only and 4 KiB-capped (streamed bytes counted), accepts exactly one `email` field (normalized like login/invitations; unexpected fields such as `next`, `redirect_to`, tenant or user ids are rejected, never used) and always answers with the same generic confirmation — an existing account, unknown account, inactive member, suppressed delivery and ordinary Auth rejection are indistinguishable, so accounts cannot be enumerated through this flow; Supabase Auth's configured recovery-email controls are the rate limit. The recovery email goes through the ordinary Supabase Auth recovery API under the **public anon key** (never the service-role key or the Auth Admin module) and lands in the local mail catcher — **no production SMTP and no hosted Supabase is configured**. The emailed link (`/auth/confirm?token_hash=…&type=recovery`, built from the canonical local site URL only — never from request headers) is verified server-side strictly as a recovery token (an invite token cannot enter recovery and vice versa; a consumed link is not replayable), yields an ordinary cookie session and leads to `/account/reset-password`, where the signed-in user — and only that user — replaces their own password (the same 12–128 character policy and parser as `/account/setup`; `POST /api/account/reset-password` calls `auth.updateUser` through the user's own session). A successful reset revokes the user's Supabase sessions globally (recovery session included; other existing sessions are rejected on their next validated request), force-clears the browser session and redirects to `/login` with a neutral notice. Password reset never creates or changes profiles, memberships, invitations or ledgers: an inactive or suspended portal user can reset their password but regains no application or database access. Custom SMTP and MFA remain future production work.

Platform administration (administrators only, under their own session — never the service-role client): `/admin/businesses/new` creates a customer business (name, lowercase slug, schema-allowed industry, a real IANA timezone verified against `pg_timezone_names`; the business starts active with no members). `/admin/businesses/<id>` shows configuration, lead counts, the registered integration sources (kind, exact external identifier, label, allowed website origin, status) and the business's **platform operations history**. From there an administrator can **suspend** a business (members lose dashboard access and lead ingestion is rejected on the next request; leads and sources are kept) and **reactivate** it (only `active ↔ suspended`; archived businesses are visible but not operable), **register** a `website_form`, `vapi_assistant` or `vapi_phone_number` source (identifier stored byte-for-byte, globally unique per kind, never moved between businesses; an optional canonical `https://` origin for website forms only), and **activate/deactivate** a source (inactive sources are rejected by `/api/internal/ingest` immediately). Every operation goes through a reviewed `SECURITY DEFINER` RPC (`admin_create_business`, `admin_set_business_status`, `admin_create_integration_source`, `admin_set_integration_source_status`; authenticated-only execute, actor from `auth.uid()`, active `PLATFORM_ADMIN` profile re-checked inside the database, rows locked before status decisions) and writes an immutable `platform_admin_events` row in the same transaction (actor UUID + display-name snapshot, status values only — never identifiers, contact data or secrets; no-op repeats write nothing). The ledger is readable only by active platform administrators; customers hold no grants on `businesses`, `integration_sources` or the ledger beyond their RLS-scoped reads. The form endpoints `POST /api/admin/businesses/actions` and `POST /api/admin/businesses/<id>/actions` are same-site, urlencoded-only, size-capped, require every field exactly once, and redirect with allow-listed result codes. Administrator lead pages stay read-only: platform operations never touch customer leads, assignments, notes, statuses or follow-ups.

Routes: `/` routes by server-validated access (no session → `/login`; admin → `/admin`; active customer → `/dashboard`; otherwise `/no-access`); `/dashboard` (summary cards, filterable recent leads, `?business=<slug>` honoured only if authorized); `/dashboard/leads/<id>` (detail + actions + timeline; anything not visible through RLS is an identical 404); `/admin` (businesses with status and lead counts, recent leads across customers, **Create business**); `/admin/businesses/new` and `/admin/businesses/<id>` (administrator operations, below); `POST /api/auth/login` and `POST /api/auth/logout` (form posts, same-site checked); `/forgot-password`, `GET /auth/confirm` (`type=invite` or `type=recovery` only) and `/account/reset-password` (password recovery, above). Public signup is disabled in `supabase/config.toml` (`[auth] enable_signup = false`); `[auth.email] enable_signup = true` only enables the email provider so password sign-in works.

How access is decided: pages use a per-request Supabase client with the **public anon key** and the user's httpOnly session cookies, so every query runs as `authenticated` under RLS. Identity is validated with the Auth server (`auth.getUser()`), then the user's own `profiles` row (system-managed `platform_role`, `is_active`) and the RLS-visible `businesses` determine access — an inactive profile, inactive membership, or suspended/archived business removes access on the next request. The service-role client is never used by pages; it remains confined to `/api/internal/ingest`, which the session proxy (`src/proxy.ts`) excludes entirely. Protected responses are `Cache-Control: private, no-store`.

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

Not built yet: any hosted Supabase project, the live n8n cutover, and notification (SMS) delivery. (Customer authentication, dashboards and invitation-only provisioning ARE built and run locally — see above.)

## About `n8n/reference/current-live-workflow.sanitized.json`

A structure-preserving, **sanitized** copy of the live production workflow, committed for review purposes only. All credentials, phone numbers, sheet IDs, webhook paths, and instance identifiers are replaced with `REDACTED_*` placeholders, and it is marked inactive. It is **not importable as a production replacement** without full reconfiguration. The raw export remains outside version control by an explicit `.gitignore` rule.
