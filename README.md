# SnowBeltTech Lead Portal

A multi-tenant lead-management portal for local service businesses (HVAC, plumbing, roofing, landscaping, cleaning, auto repair, property maintenance). Each customer business signs in and sees only its own leads; SnowBeltTech operates a platform-administrator account for support and maintenance.

## Current status

**Repository foundation only.** No application, no Supabase environment, no database schema, and no production integration exists yet. The only committed artifact besides documentation is a sanitized reference copy of the currently live n8n workflow.

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
2. **Schema/RLS** — tenancy tables, policies, isolation proofs.
3. **Trusted ingestion** — idempotent server-side lead creation for n8n.
4. **Customer portal** — auth, lead workspace MVP.
5. **Platform administration** — cross-tenant operations.
6. **n8n cutover** — replace Google Sheets, add delivery callbacks (dev-cloned workflow, synthetic submissions, reconciliation, controlled cutover; Sheets retained only as an archived backup).
7. **Production hardening** — custom SMTP, MFA, backups, deployment.

## About `n8n/reference/current-live-workflow.sanitized.json`

A structure-preserving, **sanitized** copy of the live production workflow, committed for review purposes only. All credentials, phone numbers, sheet IDs, webhook paths, and instance identifiers are replaced with `REDACTED_*` placeholders, and it is marked inactive. It is **not importable as a production replacement** without full reconfiguration. The raw export remains outside version control by an explicit `.gitignore` rule.
