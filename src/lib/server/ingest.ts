import "server-only";
import type { IngestRequest } from "@/lib/ingest/schema";
import { getAdminClient } from "./supabase-admin";

// Calls the reviewed privileged RPC and maps its result/errors to an opaque,
// minimal external contract. business_id is part of the RPC result but is
// deliberately never exposed over HTTP.

export type Outcome = "lead_created" | "duplicate_lead" | "filtered" | "duplicate_filtered";

export interface RpcRow {
  outcome: Outcome;
  should_notify: boolean;
  customer_sms_allowed: boolean;
  business_id: string;
  lead_id: string | null;
  lead_number: string | null;
  ingestion_event_id: string;
  attempt_count: number;
}

export interface PublicIngestResult {
  outcome: Outcome;
  should_notify: boolean;
  customer_sms_allowed: boolean;
  lead_id: string | null;
  lead_number: string | null;
}

export type IngestOutcome =
  | { kind: "ok"; status: 200 | 201; body: PublicIngestResult }
  | { kind: "error"; status: 403 | 422 | 500 | 503; body: { error: string }; category: string; sqlstate?: string };

const OUTCOMES: readonly Outcome[] = ["lead_created", "duplicate_lead", "filtered", "duplicate_filtered"];

/** Shapes the RPC row into the external response. Never includes business_id or internals. */
export function toPublicResult(row: RpcRow): PublicIngestResult {
  if (!OUTCOMES.includes(row.outcome)) throw new Error("unexpected RPC outcome");
  const created = row.outcome === "lead_created";
  return {
    outcome: row.outcome,
    // Notification permission comes from the database; duplicates/filtered can never notify.
    should_notify: created && row.should_notify === true,
    customer_sms_allowed: created && row.customer_sms_allowed === true,
    lead_id: row.lead_id ?? null,
    lead_number: row.lead_number ?? null,
  };
}

interface PostgrestLikeError {
  code?: string | null;
  message?: string;
}

/** Maps a database/transport failure to an opaque response plus an internal log category. */
export function mapRpcError(error: PostgrestLikeError | null, transportFailed: boolean): IngestOutcome {
  if (transportFailed) {
    return { kind: "error", status: 503, body: { error: "unavailable" }, category: "db_unavailable" };
  }
  const code = error?.code ?? undefined;
  switch (code) {
    // unknown source, inactive source, suspended/archived business -> one opaque answer
    case "P0002":
    case "55000":
      return { kind: "error", status: 403, body: { error: "source_not_accepted" }, category: "source_rejected", sqlstate: code };
    // contract violations the schema should already have caught
    case "22023":
    case "0A000":
    case "23514":
    case "22P02":
    case "22007":
    case "22008":
      return { kind: "error", status: 422, body: { error: "invalid_request" }, category: "db_validation", sqlstate: code };
    // connection / shutdown / resource classes
    case "57P01":
    case "57P02":
    case "57P03":
    case "53300":
    case "08000":
    case "08003":
    case "08006":
      return { kind: "error", status: 503, body: { error: "unavailable" }, category: "db_unavailable", sqlstate: code };
    default:
      return { kind: "error", status: 500, body: { error: "internal_error" }, category: "db_error", sqlstate: code };
  }
}

export async function ingestLeadEvent(req: IngestRequest): Promise<IngestOutcome> {
  let result: { data: unknown; error: PostgrestLikeError | null };
  try {
    result = await getAdminClient()
      .rpc("ingest_lead_event", {
        p_source_kind: req.source_kind,
        p_source_external_id: req.source_external_id,
        p_source_event_id: req.source_event_id,
        p_payload: req.payload,
      })
      .single();
  } catch {
    return mapRpcError(null, true);
  }
  if (result.error) {
    // supabase-js reports fetch failures as an error without a SQLSTATE
    const code = result.error.code ?? "";
    const transport = code === "" || code.startsWith("FETCH") || /fetch failed|ECONNREFUSED/i.test(result.error.message ?? "");
    return mapRpcError(result.error, transport);
  }
  const body = toPublicResult(result.data as RpcRow);
  return { kind: "ok", status: body.outcome === "lead_created" ? 201 : 200, body };
}
