-- =============================================================================
-- Lead search, filtering and deterministic pagination for the customer
-- workspace and CSV export.
--
-- public.search_leads is SECURITY INVOKER on purpose: every row is read under
-- the CALLER's role and the forced RLS policies on public.leads, so a foreign
-- or unknown p_business_id yields zero rows and no count, suspended/archived
-- businesses and inactive identities receive nothing, and platform
-- administrators keep exactly their existing read-only visibility. The
-- function grants no new data access of any kind - it only moves the OR-search
-- predicate into parameterized SQL so user input can never be interpreted as
-- PostgREST filter grammar.
--
-- Search covers ONLY: lead_number, contact_name, email, phone_e164,
-- requested_service. It deliberately never inspects payloads, source event
-- ids, consent text, call metadata, notes or activity rows.
--
-- Ordering is always total (created_at then id) so equal timestamps can never
-- duplicate or skip rows across pages. Callers page either by offset
-- (dashboard) or by keyset cursor (export batches); the cursor wins when both
-- are supplied. total_count is the filtered count computed BEFORE limiting.
-- =============================================================================

create function public.search_leads(
  p_business_id uuid,
  p_q text default null,
  p_status text default null,
  p_source text default null,
  p_unassigned boolean default false,
  p_assigned_to uuid default null,
  p_oldest boolean default false,
  p_limit integer default 50,
  p_offset integer default 0,
  p_cursor_created timestamptz default null,
  p_cursor_id uuid default null
)
returns table (
  id uuid,
  lead_number text,
  contact_name text,
  phone_e164 text,
  email text,
  requested_service text,
  source text,
  status text,
  urgency text,
  review_recommended boolean,
  created_at timestamptz,
  follow_up_at timestamptz,
  assigned_to uuid,
  total_count bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_q       text;
  v_pattern text;
  v_digits  text := '';
  v_alnum   text := '';
  v_limit   integer;
  v_offset  integer;
begin
  v_limit  := least(greatest(coalesce(p_limit, 50), 1), 1000);
  v_offset := least(greatest(coalesce(p_offset, 0), 0), 1000000);

  -- Defensive normalization (the application normalizes first): trim, collapse
  -- internal whitespace, bound the length. The pattern escapes LIKE wildcards
  -- so user input matches literally; the digit/alnum variants keep phone and
  -- lead-number searches useful when the user types punctuation.
  v_q := nullif(left(btrim(regexp_replace(coalesce(p_q, ''), '\s+', ' ', 'g')), 120), '');
  if v_q is not null then
    v_pattern := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    v_digits  := regexp_replace(v_q, '[^0-9]', '', 'g');
    v_alnum   := upper(regexp_replace(v_q, '[^A-Za-z0-9]', '', 'g'));
  end if;

  return query
  select
    l.id, l.lead_number, l.contact_name, l.phone_e164, l.email,
    l.requested_service, l.source, l.status, l.urgency,
    l.review_recommended, l.created_at, l.follow_up_at, l.assigned_to,
    count(*) over () as total_count
  from public.leads l
  where l.business_id = p_business_id
    and l.archived_at is null
    and (p_status is null or l.status = p_status)
    and (p_source is null or l.source = p_source)
    and (not coalesce(p_unassigned, false) or l.assigned_to is null)
    and (p_assigned_to is null or l.assigned_to = p_assigned_to)
    and (v_q is null
         or l.lead_number ilike v_pattern escape '\'
         or l.contact_name ilike v_pattern escape '\'
         or coalesce(l.email, '') ilike v_pattern escape '\'
         or coalesce(l.phone_e164, '') ilike v_pattern escape '\'
         or coalesce(l.requested_service, '') ilike v_pattern escape '\'
         -- digit matching only for phone-shaped queries (no letters), so a
         -- letter-and-digit token can never coincidentally match a phone
         or (v_q !~ '[A-Za-z]' and length(v_digits) >= 3
             and regexp_replace(coalesce(l.phone_e164, ''), '[^0-9]', '', 'g') like '%' || v_digits || '%')
         or (length(v_alnum) >= 3
             and replace(l.lead_number, '-', '') like '%' || v_alnum || '%'))
    and (p_cursor_created is null or p_cursor_id is null
         or case when coalesce(p_oldest, false)
              then (l.created_at, l.id) > (p_cursor_created, p_cursor_id)
              else (l.created_at, l.id) < (p_cursor_created, p_cursor_id)
            end)
  order by
    case when coalesce(p_oldest, false) then l.created_at end asc,
    case when coalesce(p_oldest, false) then l.id end asc,
    l.created_at desc,
    l.id desc
  limit v_limit
  offset case when p_cursor_created is null or p_cursor_id is null then v_offset else 0 end;
end;
$$;

comment on function public.search_leads is
  'RLS-respecting (SECURITY INVOKER) lead search/pagination for the customer workspace and CSV export. Searches lead_number, contact_name, email, phone_e164, requested_service only.';

-- Least privilege: authenticated sessions only. No PUBLIC, no anon; the
-- service-role client has no business calling this (customer surfaces use the
-- ordinary session client).
revoke all on function public.search_leads(uuid, text, text, text, boolean, uuid, boolean, integer, integer, timestamptz, uuid) from public;
grant execute on function public.search_leads(uuid, text, text, text, boolean, uuid, boolean, integer, integer, timestamptz, uuid) to authenticated;
