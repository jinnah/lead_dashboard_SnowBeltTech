# CLAUDE.md

Governing rules for the SnowBeltTech Lead Portal repository. Read this in full before any work.

## Product boundary

- This is a **focused multi-tenant Lead Portal** for local service businesses (HVAC, plumbing, roofing, landscaping, cleaning, auto repair, property maintenance). Leads are contacts/service requests — never authenticated dashboard users.
- It is **not** a replacement, fork, or evolution of `service_CRM` (the separate premium, isolated, single-tenant product). Study that repository for proven designs, tests and patterns; never copy its code blindly and never modify it from this project.
- **One system of record per business**: a business uses either the shared Lead Portal or a dedicated single-tenant CRM install — never both simultaneously. SnowBeltTech itself is the first Portal tenant.
- No jobs, invoices, payments, commercial documents or document-storage functionality unless separately and explicitly authorized.
- Google Sheets is not a synchronized second system of record. It may be imported once and retained only as an archived backup.

## Architecture

- **Modular monolith.** One shared Next.js application (customer portal + platform administration), one shared Supabase production project, one separate Supabase development project.
- **Supabase Postgres** is the sole lead system of record; **Supabase Auth** for dashboard authentication.
- Tenant-owned rows use one consistent key: **`business_id`** (provisional; change only with review).
- The existing shared self-hosted **n8n** remains the private automation/orchestration layer. **Twilio** is managed by SnowBeltTech. Customers never receive access to n8n, Supabase administration, Twilio administration, or infrastructure.
- n8n integrates through authenticated HTTP APIs / RPC boundaries with server-held credentials — never through direct uncontrolled database access.
- Intended portal hostname: `portal.snowbelttech.com`. Existing n8n hostname: `n8n.snowbelttech.com`.

## Tenant isolation (non-negotiable)

- Tenant isolation is enforced by **PostgreSQL Row Level Security**, not by frontend filtering. RLS must be **enabled and forced** on every tenant table.
- Every `UPDATE` policy requires both `USING` and `WITH CHECK`.
- Tenant keys (`business_id`) are **immutable** once set.
- **Never trust a tenant ID** supplied by a public form, browser state, query parameters, request bodies, Vapi structured output, or any other customer-controlled value. Resolve the tenant from trusted server-side information only (authenticated membership, registered integration source, assistant/phone-number mapping).
- The platform role must never come from user-editable metadata (e.g. `auth.users.raw_user_meta_data`).
- The Supabase service-role/secret key never reaches browser code. No secret in any `NEXT_PUBLIC_*` variable.
- No `DELETE` policies on tenant business data unless explicitly reviewed — removal is archival.
- **MVP read model:** every active member of a business sees all leads belonging to that business. Assignment is stored and filterable but is not a read-access boundary; tenant isolation is the initial security boundary.
- Roles: `PLATFORM_ADMIN` (SnowBeltTech, all businesses, via normal Supabase Auth — no hidden impersonation), and per-business `BUSINESS_OWNER` / `BUSINESS_MANAGER` / `BUSINESS_STAFF` via membership rows. Open public signup is disabled; customer users are created by invitation.

## Ingestion invariants

- **Durable lead creation before notification.** A Twilio failure must never lose or roll back a lead.
- Idempotency is database-enforced on trusted **`business_id` + `source` + full `source_event_id`** (the complete Vapi call ID — never a truncated suffix).
- Duplicate delivery of the same source event must not create a second lead and must not resend SMS.
- **Twilio acceptance is not delivery.** Message lifecycle is tracked through authenticated delivery-status callbacks; `delivered`/`failed` are terminal.
- Provider callbacks must be authenticated (Twilio signature verification; Vapi verification per its supported mechanism). A browser-delivered value is never a secret: browser-direct forms rely on source identifiers for routing plus validation, origin checks as defense-in-depth, honeypot, CAPTCHA/Turnstile, rate limiting and idempotent submission IDs; real shared secrets/signatures exist only server-to-server.
- Filtered voice calls (non-leads) remain auditable as ingestion events; they never silently vanish.
- Never silently merge uncertain leads — ambiguity flags for human review.
- Audit honesty: RLS authorizes platform-admin access but does not record reads. Do not claim read auditing unless an explicit, verified logging mechanism exists. Mutation auditing is required in a later phase; read auditing is a separate production-hardening decision.

## Repository and review rules

- Inspect `git status` (including untracked files) before changing anything; preserve user-owned changes. Never reset, discard or clean existing work.
- Work proceeds in **small, bounded, independently reviewed batches**. Codex review is required between batches. Do not broaden scope without approval.
- Tests and exact results are required before commits. Never commit credentials, PII, or raw production workflow exports. The raw export `SnowbeltTech - Form_call - Google Sheets and SMS.json` stays ignored and untracked; only the sanitized reference under `n8n/reference/` is committed.
- No production changes without explicit authorization. Do not modify `service_CRM`. Do not modify the live n8n workflow from this repository.
- This repository is public: everything committed is permanent and world-readable.
