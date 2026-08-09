-- S-06: Public submission form — the anon write surface.
--
-- The product's ONLY unauthenticated write path. Until this migration the
-- `anon` role held zero privileges on every table (20260804171802
-- _submission_intake.sql:72 revokes them outright), so everything below is the
-- first privilege that role gets, and the shape it takes is what later slices
-- will copy.
--
-- Four objects, in order:
--   1. public_form_company()  — resolve a link's company id to a display name
--   2. the column-scoped anon insert grant on public.submissions
--   3. submissions_insert_public_form — the anon policy pinning source = 'form'
--   4. enforce_form_submission_rate() + its BEFORE INSERT trigger — the cap
--
-- Nothing in the application changes yet; the database is left in a working
-- state on its own.

-- ---------------------------------------------------------------------------
-- public_form_company(): the one thing an anonymous caller may learn about a
-- company, and only when they already hold its id.
--
-- A `security definer` function taking the id as an EXACT-MATCH argument, never
-- an RLS policy on public.companies. A readable-by-anon select policy on that
-- table would be a mass-disclosure bug: PostgREST allows an unfiltered select,
-- so any such policy hands over every tenant row in a single request. A
-- function takes one id and can return at most that one company's name.
--
-- Returning a TABLE rather than a scalar is load-bearing. The public page
-- renders three different things and needs to tell them apart:
--   zero rows            -> the link is dead (account gone); show the
--                           dead-link panel before the customer types 2000
--                           characters and loses them
--   one row, name NULL   -> the link is live, the owner has not filled in
--                           their profile yet; show neutral wording
--   one row, name set    -> name the business in the heading
-- A scalar returning NULL cannot distinguish the first two cases.
--
-- This is a deliberate, recorded relaxation of the placeholder page's
-- "not a membership oracle" stance: a valid id now renders differently from an
-- invalid one. At 122 bits of entropy (gen_random_uuid) that is not a practical
-- enumeration channel, and it buys the guardrail that no submission is lost to
-- a dead link.
--
-- security definer + stable + `set search_path = ''` + revoke-from-public +
-- targeted grant mirrors public.current_company_id()
-- (20260726104601_owner_auth_tenant_isolation.sql:61-75).
-- ---------------------------------------------------------------------------
create function public.public_form_company(p_company_id uuid)
  returns table (name text)
  language sql
  security definer
  stable
  set search_path = ''
as $$
  select c.name from public.companies c where c.id = p_company_id
$$;

comment on function public.public_form_company(uuid) is
  'Resolves a public form link''s company id to a display name. Exact-match only and returns just `name` — never a policy on public.companies, which PostgREST would let anon read unfiltered. Zero rows = dead link; one row with NULL name = live link, unnamed company.';

revoke all on function public.public_form_company(uuid) from public;
-- `authenticated` is included so an owner previewing their own form is not a
-- special case that only breaks while logged in.
grant execute on function public.public_form_company(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Privileges for anon: insert, three columns, and nothing else.
--
-- Narrowest verb AND narrowest column set (context/foundation/lessons.md). A
-- table-wide insert grant would let a stranger choose `id` and `created_at`.
-- No select (so no `.select()` seatbelt on the public insert — an INSERT
-- rejection is loud on its own), no update, no delete, and nothing at all on
-- public.companies.
-- ---------------------------------------------------------------------------
grant insert (company_id, content, source) on public.submissions to anon;

-- ---------------------------------------------------------------------------
-- The symmetric partner to submissions_insert_own_manual: an anon caller may
-- only write rows marked as coming from the form, exactly as an authenticated
-- owner may only write rows marked 'manual'. Neither role can forge the other's
-- provenance, not even through a raw PostgREST call with the public anon key.
--
-- It deliberately does NOT constrain company_id, which is the first thing a
-- reader will question given the asymmetry with the policy above it. The link
-- IS the capability: an unauthenticated caller has no session to derive a
-- company from, and the id in the URL is unguessable by FR-004/NFR. The foreign
-- key is what rejects an id naming no company (23503).
-- ---------------------------------------------------------------------------
create policy "submissions_insert_public_form"
  on public.submissions for insert
  to anon
  with check (source = 'form');

-- ---------------------------------------------------------------------------
-- enforce_form_submission_rate(): the abuse bound.
--
-- A BEFORE INSERT trigger rather than a clause in the policy's `with check`,
-- for two reasons. A `with check` subquery counting rows on the table being
-- inserted into has murky visibility semantics; a trigger is unambiguous. And a
-- trigger can raise a DISTINCT sqlstate, so the Server Action can tell "you are
-- being throttled" from "something failed" without matching on an error string.
--
-- This is the layer that actually bounds the damage: it holds against a caller
-- who skips the page entirely and posts straight at PostgREST with the public
-- anon key. The honeypot and timing checks the form carries are speed bumps.
--
-- The count is served by submissions_company_created_idx
-- (20260804171802_submission_intake.sql:126), which already leads on
-- (company_id, created_at desc) and covers this predicate exactly — no new
-- index.
-- ---------------------------------------------------------------------------
create function public.enforce_form_submission_rate()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  recent_count integer;
begin
  -- Owner-entered rows are not rate limited: they arrive one at a time from a
  -- person who is already authenticated, and capping them would be capping the
  -- product's own feature.
  if new.source <> 'form' then
    return new;
  end if;

  -- Cap: 30 form submissions per company per hour. The threshold and the
  -- interval are named together here so the two cannot drift apart.
  select count(*) into recent_count
  from public.submissions
  where company_id = new.company_id
    and source = 'form'
    and created_at > now() - interval '1 hour';

  -- PT429: PostgREST maps a PTxyz sqlstate onto HTTP status xyz, so this
  -- surfaces as a 429 and reaches supabase-js as error.code = 'PT429'.
  -- The message names only the company id — safe to log, and it never reaches
  -- the customer, who sees the action's own Polish throttled message.
  if recent_count >= 30 then
    raise exception 'form submission rate limit exceeded for company %', new.company_id
      using errcode = 'PT429';
  end if;

  return new;
end;
$$;

comment on function public.enforce_form_submission_rate() is
  'Caps public-form submissions at 30 per company per hour, raising sqlstate PT429 (PostgREST -> HTTP 429). Short-circuits for source <> ''form'', so the owner''s manual path is untouched.';

create trigger enforce_form_submission_rate
  before insert on public.submissions
  for each row execute function public.enforce_form_submission_rate();
