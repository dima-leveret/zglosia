-- Implementation-review fix (F4) for 20260814132833_generate_action_plan.sql.
--
-- That file states save_action_plan() is a boundary that holds "against a direct
-- PostgREST call with a leaked key", and for the two guarantees it names —
-- grounding and tenancy — it is. But one bound it relies on lives only in Zod,
-- which such a call skips entirely: PLAN_PROBLEMS_MAX = 8 in
-- src/lib/plan-schema.ts has no database counterpart, unlike the string caps,
-- every one of which is mirrored as a CHECK constraint precisely because "Zod is
-- not a boundary here".
--
-- Without it, an authenticated caller posting a p_problems array of 50,000
-- elements makes this function loop 50,000 times inside one transaction. The
-- blast radius is the caller's OWN tenant — every problem still needs citations
-- resolving to that company's own submissions, so nothing crosses a company
-- line — which is why this is a bound, not a vulnerability. It closes the gap
-- between what the function's prose claims and what it enforces.
--
-- The empty-array check the original wrote is folded into the same statement:
-- one place naming both ends of the range so they cannot drift, the same
-- reasoning enforce_plan_generation_rate() gives for naming its threshold and
-- its interval together.
--
-- Everything else in the body is unchanged from 20260814132833. `create or
-- replace function` preserves the existing ACL, so the anon revoke from
-- 20260814134807_harden_plan_rpc_grants.sql survives — but it is re-asserted at
-- the foot of this file anyway, because a privilege that depends on a reader
-- knowing that rule is a privilege that goes missing the next time this function
-- is replaced (context/foundation/lessons.md — "Grants ship in the migration
-- that creates the object").

create or replace function public.save_action_plan(p_summary text, p_problems jsonb)
  returns uuid
  language plpgsql
  security definer
  volatile
  set search_path = ''
as $$
declare
  v_company_id   uuid;
  v_plan_id      uuid;
  v_problem      jsonb;
  v_problem_id   uuid;
  v_rank         integer := 0;
  v_requested    integer;
  v_inserted     integer;
  v_action_count integer;
begin
  v_company_id := public.current_company_id();

  -- 42501 (insufficient_privilege), not a generic failure: a caller with no
  -- company has no business writing a plan, and this is the same shape a
  -- missing grant would take.
  if v_company_id is null then
    raise exception 'save_action_plan: no company for the calling user'
      using errcode = '42501';
  end if;

  -- A plan with zero problems is not a plan, and a plan with fifty thousand is
  -- not one either. The upper bound mirrors PLAN_PROBLEMS_MAX in
  -- src/lib/plan-schema.ts — change these together, exactly as the string
  -- CHECKs and their Zod counterparts are changed together. The Server Action
  -- already refuses both ends; this is the independent second layer, and the
  -- only one a direct PostgREST call meets.
  if jsonb_typeof(p_problems) <> 'array'
     or jsonb_array_length(p_problems) = 0
     or jsonb_array_length(p_problems) > 8
  then
    raise exception 'save_action_plan: a plan must carry between 1 and 8 problems'
      using errcode = '22023';
  end if;

  insert into public.action_plans (company_id, summary)
  values (v_company_id, p_summary)
  returning id into v_plan_id;

  for v_problem in select * from jsonb_array_elements(p_problems)
  loop
    v_rank := v_rank + 1;

    insert into public.plan_problems (plan_id, rank, title, rationale)
    values (
      v_plan_id,
      v_rank,
      v_problem ->> 'title',
      v_problem ->> 'rationale'
    )
    returning id into v_problem_id;

    -- Actions, numbered from their position in the array for the same reason
    -- rank is: the ordering is data the caller supplies implicitly, not a
    -- field it can contradict.
    insert into public.plan_actions (problem_id, position, content)
    select v_problem_id, a.ord::integer, a.value
    from jsonb_array_elements_text(coalesce(v_problem -> 'actions', '[]'::jsonb))
      with ordinality as a(value, ord);

    get diagnostics v_action_count = row_count;

    if v_action_count = 0 then
      raise exception 'save_action_plan: problem % carries no actions', v_rank
        using errcode = '22023';
    end if;

    -- DISTINCT: a model that cites the same submission twice is sloppy, not
    -- ungrounded, and counting raw array length would turn that into a refused
    -- save. The check below must fire on ids that do not RESOLVE, and on
    -- nothing else.
    select count(distinct value)
      into v_requested
    from jsonb_array_elements_text(coalesce(v_problem -> 'submissionIds', '[]'::jsonb));

    if v_requested = 0 then
      raise exception 'save_action_plan: problem % cites no submission', v_rank
        using errcode = '22023';
    end if;

    -- The load-bearing statement in this whole migration. Note the company
    -- filter: this function runs as its owner and therefore BYPASSES RLS on
    -- public.submissions, so the predicate here is the only thing scoping the
    -- lookup to the caller's own rows.
    insert into public.plan_problem_submissions (problem_id, submission_id)
    select v_problem_id, s.id
    from public.submissions s
    where s.company_id = v_company_id
      and s.id in (
        select value::uuid
        from jsonb_array_elements_text(v_problem -> 'submissionIds')
      );

    get diagnostics v_inserted = row_count;

    -- ...and the check that gives it teeth. Fewer rows than ids means at least
    -- one citation named a submission this company does not have. Raising
    -- aborts the transaction, so the header and everything under it are rolled
    -- back: a plan that cannot be fully grounded is not saved at all.
    if v_inserted <> v_requested then
      raise exception
        'save_action_plan: problem % cites % submission(s), % of which belong to company %',
        v_rank, v_requested, v_inserted, v_company_id
        using errcode = '23514';
    end if;
  end loop;

  return v_plan_id;
end;
$$;

comment on function public.save_action_plan(text, jsonb) is
  'Saves one action plan atomically (FR-012). Resolves the company from the session, never from an argument, and refuses any citation that does not resolve to a submission of that company — the anti-hallucination NFR as a database guarantee. Accepts between 1 and 8 problems, mirroring PLAN_PROBLEMS_MAX in src/lib/plan-schema.ts. p_problems: [{title, rationale, submissionIds[], actions[]}], array order is the priority order. EXECUTE is held by `authenticated` only.';

-- Re-asserted rather than assumed. `create or replace` keeps the existing ACL,
-- so these are no-ops today — but they are what makes the privilege legible in
-- the file that last touched the function, instead of a property a reader has to
-- reconstruct from two earlier migrations.
revoke all on function public.save_action_plan(text, jsonb) from public, anon;
grant execute on function public.save_action_plan(text, jsonb) to authenticated;
