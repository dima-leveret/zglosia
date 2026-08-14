-- Implementation-review fix (F5) for 20260814132833_generate_action_plan.sql.
--
-- enforce_plan_generation_rate() counts the company's recent rows and then lets
-- the insert proceed. Under READ COMMITTED — Postgres's default, and what
-- PostgREST uses — two concurrent inserts can each observe 9 existing rows,
-- each conclude they are under the cap of 10, and both succeed. The company
-- lands at 11.
--
-- The overshoot is bounded by concurrency rather than unbounded, which is why
-- this was an observation and not a defect: a browser tab spamming the button
-- costs a handful of extra model calls past the cap, not a runaway. It is fixed
-- anyway because of WHAT this particular trigger guards. Its precedent,
-- enforce_form_submission_rate() (20260809151843), bounds spam volume, where a
-- few rows over the line cost nothing; this one bounds spend against a paid API,
-- and "approximately ten" is a weaker promise than the comment on
-- public.plan_generations makes.
--
-- The fix is a transaction-scoped advisory lock keyed on the company, taken
-- BEFORE the count. Concurrent inserts for the same company serialise behind it
-- and each sees the other's committed row; inserts for DIFFERENT companies take
-- different keys and never contend, so one tenant cannot slow another down. The
-- lock is released at commit or rollback with no explicit unlock, which is the
-- whole reason for the _xact_ variant — a session-scoped lock leaked on an
-- aborted insert would wedge that company's cap until the pooled connection was
-- recycled.
--
-- Everything else in the body is unchanged from 20260814132833, threshold and
-- interval included, still named together in one place so they cannot drift.
--
-- enforce_form_submission_rate() is deliberately NOT touched. It has the same
-- shape and the same race, but the public form is anon-facing and high-traffic,
-- and serialising it per company would add contention to the one path in this
-- app that actually sees concurrent writes — for a bound where the exact
-- boundary does not matter. Different property, different call.

create or replace function public.enforce_plan_generation_rate()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  recent_count integer;
begin
  -- Serialise same-company attempts before counting. The first argument is a
  -- fixed namespace so this lock cannot collide with an advisory lock taken
  -- anywhere else for an unrelated purpose that happens to hash a company id to
  -- the same value; the second is the company. Schema-qualified because this
  -- function runs with `search_path = ''`.
  perform pg_catalog.pg_advisory_xact_lock(
    8303, pg_catalog.hashtext(new.company_id::text)
  );

  -- Cap: 10 plan generations per company per day. The threshold and the
  -- interval are named together here so the two cannot drift apart.
  select count(*) into recent_count
  from public.plan_generations
  where company_id = new.company_id
    and created_at > now() - interval '1 day';

  -- PT429: PostgREST maps a PTxyz sqlstate onto HTTP status xyz, so this
  -- surfaces as a 429 and reaches supabase-js as error.code = 'PT429'. The
  -- message names only the company id — safe to log, and it never reaches the
  -- owner, who sees the action's own throttled message.
  if recent_count >= 10 then
    raise exception 'plan generation rate limit exceeded for company %', new.company_id
      using errcode = 'PT429';
  end if;

  return new;
end;
$$;

comment on function public.enforce_plan_generation_rate() is
  'Caps action-plan generation attempts at 10 per company per day, raising sqlstate PT429 (PostgREST -> HTTP 429). Bounds the paid model call behind the Generate button. Takes a per-company transaction-scoped advisory lock before counting, so concurrent attempts cannot both pass the check and land the company over the cap.';
