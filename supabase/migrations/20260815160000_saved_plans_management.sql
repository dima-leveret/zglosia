-- S-04: Saved plans management — list, edit, delete (FR-013, FR-014).
--
-- 20260814132833_generate_action_plan.sql closes with an explicit statement of
-- what it withheld:
--
--   "Scope is deliberately narrow. FR-013 (list plans) and FR-014 (edit/delete
--    plans) are S-04, so there is no update grant, no delete grant, no
--    updated_at column and no touch trigger anywhere in this file. That absence
--    is a decision, not an oversight."
--
-- This is that file. It opens exactly the surface FR-014 needs and not one verb
-- more, keeping S-03's posture intact:
--
--   * The four plan tables stay SELECT-only for `authenticated`, with ONE new
--     exception — `delete` on public.action_plans. A whole-plan delete cannot
--     corrupt anything: it removes a header and everything hanging off it via
--     the cascades S-03 already declared. There is no invariant left to break,
--     so there is nothing for an RPC to protect.
--
--   * There is deliberately NO update grant on any plan table, and NO delete
--     grant on any CHILD table. Both absences are decisions:
--
--       - A table-wide `update` on action_plans would let an owner holding
--         nothing but an anon-key session rewrite their own `id`, `company_id`
--         and `created_at` — the exact defect
--         20260730190000_narrow_company_write_grants.sql was written to undo on
--         public.companies, where RLS could not express column scope. Even a
--         column-scoped `update (summary)` would be wrong here, because a plan
--         edit is a multi-table transaction (header text, problem text, action
--         text, removals, renumbering) that a sequence of PostgREST PATCHes
--         cannot make atomic.
--
--       - A `delete` on plan_problems or plan_actions would let a direct caller
--         strip a plan down row by row, outside the floors update_action_plan()
--         enforces (>= 1 problem, >= 1 action per problem) and without the
--         renumber that keeps `rank` and `position` contiguous. Removal is a
--         consequence of posting a new desired state, never a call of its own.
--         The children of a deleted plan go with `on delete cascade`, which
--         needs no grant.
--
-- Every structural write therefore still goes through a `security definer` RPC,
-- so the guarantees hold against a direct PostgREST call with a leaked anon key
-- and not merely against a well-behaved Server Action.

-- ---------------------------------------------------------------------------
-- The edit surface on action_plans.
--
-- `original_content` carries the roadmap's requirement for this slice —
-- "pozadane zachowanie oryginalu generacji, by edycja nie zacierala, co dal
-- model". NULL means "never edited": it is both the flag and the store, which is
-- why there is no separate `edited_at` or `is_edited` column. One column cannot
-- disagree with itself.
--
-- It is a snapshot, not a trail. update_action_plan() writes it once, on the
-- first edit, and never again, so a plan edited five times still shows what the
-- model produced rather than the state before the most recent change.
--
-- The CHECK is here for the same reason every string bound in
-- 20260814132833 is: Zod is not a boundary — a direct PostgREST call skips it
-- entirely. It is deliberately shallow (is this an object at all?) rather than a
-- structural validation of the snapshot, because the only writer is the RPC
-- below, which builds the value from stored rows and never from the payload.
-- Rendering re-parses it with PlanOriginalSchema instead of trusting it.
-- ---------------------------------------------------------------------------
alter table public.action_plans
  add column updated_at       timestamptz not null default now(),
  add column original_content jsonb;

alter table public.action_plans
  add constraint action_plans_original_content_object check (
    original_content is null or jsonb_typeof(original_content) = 'object'
  );

comment on column public.action_plans.updated_at is
  'Last modification, stamped by the action_plans_touch_updated_at trigger. Equal to created_at until the plan is first edited.';

comment on column public.action_plans.original_content is
  'Snapshot of the plan as the model generated it, taken by public.update_action_plan() on the FIRST edit only. NULL means the plan has never been edited — the flag and the store are one column so they cannot disagree. Shape: {summary, problems: [{title, rationale, actions: [text]}]}.';

-- Reuses the generic function from 20260729171332_company_profile.sql:48. No new
-- function: that one already does exactly this and nothing else.
create trigger action_plans_touch_updated_at
  before update on public.action_plans
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Delete: the one new table privilege in this slice.
--
-- Granted to `authenticated` only; `anon` still gets nothing at all on any plan
-- table, as S-03 established. The policy scopes it to the caller's own company
-- with the same subselect wrapper every other policy in this schema uses, so
-- current_company_id() is evaluated once per statement (InitPlan) rather than
-- once per row.
--
-- The application still pins `company_id` in its own filter as a seatbelt
-- (src/app/dashboard/submissions/actions.ts sets the precedent), which is what
-- makes a zero-row delete observable to the Server Action rather than a silent
-- success.
-- ---------------------------------------------------------------------------
grant delete on public.action_plans to authenticated;

create policy "action_plans_delete_own"
  on public.action_plans for delete
  to authenticated
  using (company_id = (select public.current_company_id()));

comment on policy "action_plans_delete_own" on public.action_plans is
  'FR-014: an owner may delete their own saved plans. Children (plan_problems, plan_actions, plan_problem_submissions) go with the on-delete cascades declared in 20260814132833, which is why no child table carries a delete grant.';

-- ---------------------------------------------------------------------------
-- update_action_plan(): the second and last write path into the plan tables.
--
-- WHY AN RPC, AGAIN: the reasons save_action_plan() gives apply unchanged.
-- supabase-js has no transaction API, and one plan edit spans three tables —
-- rewritten text, removed problems, removed actions, and a renumber of what
-- survives. A sequence of PostgREST calls can leave a plan with a gap in its
-- `rank`, or with a problem stripped of its last action, if any one of them
-- fails midway.
--
-- WHOLE DESIRED STATE, NOT A DIFF THE CALLER COMPUTES. p_problems is the plan
-- as the owner wants it to be. Ids present survive and have their text
-- rewritten; ids absent are deleted. That is what makes removal free of a second
-- call, what makes Cancel in the editor a genuine no-op on the database, and
-- what lets the whole edit be one transaction.
--
--   [{ "id": uuid, "title": text, "rationale": text,
--      "actions": [{ "id": uuid, "content": text }] }]
--
-- Array order IS the priority order. `rank` and `position` are assigned from the
-- position in the array and never read from the payload — the same contract
-- save_action_plan() states: "the ordering is data the caller supplies
-- implicitly, not a field it can contradict."
--
-- CITATIONS ARE NOT TOUCHED. plan_problem_submissions is written only by
-- save_action_plan(). Editing rewrites the words around the evidence; it never
-- edits the evidence, and it cannot create a problem, because an owner-authored
-- problem would cite nothing and put an ungrounded row into the table whose
-- entire purpose is grounding. The rows of a REMOVED problem go with it, via the
-- cascade — the plan no longer claims that problem, so it no longer needs to
-- prove it.
--
-- THREE DISTINCT SQLSTATES, on purpose. The Server Action logs the code and
-- shows one generic message; the contract suite asserts on each one
-- specifically, which is how a denial is told apart from an empty result:
--
--   42501  tenancy — no company, or the plan is not this company's
--   22023  a violated floor or bound, or a malformed id set
--   23514  an id that does not belong to the plan / to the problem
--
-- The company is resolved from the session via current_company_id() and is NEVER
-- taken from an argument. `security definer` + `set search_path = ''` +
-- revoke-from-public-AND-anon + targeted grant, per
-- 20260726104601_owner_auth_tenant_isolation.sql:61-75 and the trap
-- 20260814134807_harden_plan_rpc_grants.sql documents.
-- ---------------------------------------------------------------------------
create function public.update_action_plan(
  p_plan_id  uuid,
  p_summary  text,
  p_problems jsonb
)
  returns void
  language plpgsql
  security definer
  volatile
  set search_path = ''
as $$
declare
  v_company_id uuid;
  v_plan_id    uuid;
  v_original   jsonb;
  v_problem    jsonb;
  v_problem_id uuid;
  v_rank       integer := 0;
  v_actions    jsonb;
  v_posted     integer;
  v_distinct   integer;
  v_resolved   integer;
begin
  v_company_id := public.current_company_id();

  -- 42501 (insufficient_privilege), matching save_action_plan(): a caller with
  -- no company has no business editing a plan, and this is the same shape a
  -- missing grant would take.
  if v_company_id is null then
    raise exception 'update_action_plan: no company for the calling user'
      using errcode = '42501';
  end if;

  -- Both ends of the range named in one statement so they cannot drift, exactly
  -- as 20260814184500_bound_plan_problem_count.sql folded the floor and the
  -- ceiling together for save_action_plan(). The upper bound mirrors
  -- PLAN_PROBLEMS_MAX in src/lib/plan-schema.ts; the floor is what stops an edit
  -- from emptying a plan out through the removal path.
  if jsonb_typeof(p_problems) <> 'array'
     or jsonb_array_length(p_problems) = 0
     or jsonb_array_length(p_problems) > 8
  then
    raise exception 'update_action_plan: a plan must carry between 1 and 8 problems'
      using errcode = '22023';
  end if;

  -- THE TENANCY CHECK. This function is `security definer` and therefore
  -- bypasses RLS on every table it touches, so this predicate is the only thing
  -- scoping the whole call to the caller's own data. `for update` serialises two
  -- concurrent edits of the same plan behind each other, so the renumber below
  -- cannot interleave with another transaction's.
  --
  -- 42501 rather than a "not found": a plan id belonging to another company and
  -- a plan id that never existed are refused identically, which is the same
  -- no-oracle posture /dashboard/plans/[planId] takes with notFound().
  select ap.id, ap.original_content
    into v_plan_id, v_original
  from public.action_plans ap
  where ap.id = p_plan_id
    and ap.company_id = v_company_id
  for update;

  if not found then
    raise exception 'update_action_plan: plan % is not accessible to company %',
      p_plan_id, v_company_id
      using errcode = '42501';
  end if;

  -- ---------------------------------------------------------------------
  -- Snapshot FIRST, before anything is written.
  --
  -- Built from the STORED ROWS, never from p_problems: the point is to record
  -- what the model produced, and the payload is what the client claims it
  -- produced. Taking it after the delete would record the post-edit state as the
  -- "original", which is the one thing this column must never hold.
  --
  -- Written once. `original_content is null` is both the never-edited flag and
  -- the write guard, so a second edit leaves the model's first output alone.
  -- ---------------------------------------------------------------------
  if v_original is null then
    update public.action_plans ap
      set original_content = jsonb_build_object(
        'summary', ap.summary,
        'problems', coalesce(
          (
            select jsonb_agg(
                     jsonb_build_object(
                       'title',     pp.title,
                       'rationale', pp.rationale,
                       'actions', coalesce(
                         (
                           select jsonb_agg(pa.content order by pa.position)
                           from public.plan_actions pa
                           where pa.problem_id = pp.id
                         ),
                         '[]'::jsonb
                       )
                     )
                     order by pp.rank
                   )
            from public.plan_problems pp
            where pp.plan_id = v_plan_id
          ),
          '[]'::jsonb
        )
      )
    where ap.id = v_plan_id;
  end if;

  -- ---------------------------------------------------------------------
  -- Verify the posted problem ids, in the count-mismatch shape
  -- save_action_plan() uses for citations.
  --
  -- The first check catches a missing or duplicated id: count(distinct ...)
  -- ignores NULLs, so an element without an `id` and an element repeating
  -- another's both make the two counts disagree. Either is a malformed payload
  -- (22023), not a tenancy question.
  --
  -- The second is the tenancy question: an id that does not resolve under
  -- plan_id = this plan belongs to someone else's plan, or to no plan at all.
  -- 23514, and the transaction aborts — never a partial apply. This is also the
  -- stale-tab case: a payload naming a problem deleted in another tab fails
  -- whole, and a reload shows current state.
  -- ---------------------------------------------------------------------
  select count(*), count(distinct (e.value ->> 'id'))
    into v_posted, v_distinct
  from jsonb_array_elements(p_problems) as e;

  if v_posted <> v_distinct then
    raise exception 'update_action_plan: every problem must carry a distinct id'
      using errcode = '22023';
  end if;

  select count(*)
    into v_resolved
  from public.plan_problems pp
  where pp.plan_id = v_plan_id
    and pp.id in (
      select (e.value ->> 'id')::uuid
      from jsonb_array_elements(p_problems) as e
    );

  if v_resolved <> v_posted then
    raise exception
      'update_action_plan: % problem(s) posted, % of which belong to plan %',
      v_posted, v_resolved, v_plan_id
      using errcode = '23514';
  end if;

  -- Removals are "this id was not in the payload". Cascades take the removed
  -- problems' actions AND their citations with them.
  delete from public.plan_problems pp
  where pp.plan_id = v_plan_id
    and pp.id not in (
      select (e.value ->> 'id')::uuid
      from jsonb_array_elements(p_problems) as e
    );

  for v_problem in select * from jsonb_array_elements(p_problems)
  loop
    v_rank       := v_rank + 1;
    v_problem_id := (v_problem ->> 'id')::uuid;
    v_actions    := v_problem -> 'actions';

    -- The per-problem floor and ceiling, both ends named together again.
    -- PROBLEM_ACTIONS_MAX in src/lib/plan-schema.ts is the 5.
    if jsonb_typeof(v_actions) <> 'array'
       or jsonb_array_length(v_actions) = 0
       or jsonb_array_length(v_actions) > 5
    then
      raise exception
        'update_action_plan: problem % must carry between 1 and 5 actions', v_rank
        using errcode = '22023';
    end if;

    select count(*), count(distinct (a.value ->> 'id'))
      into v_posted, v_distinct
    from jsonb_array_elements(v_actions) as a;

    if v_posted <> v_distinct then
      raise exception
        'update_action_plan: every action of problem % must carry a distinct id', v_rank
        using errcode = '22023';
    end if;

    -- Scoped to THIS problem, not to the plan: an action id that belongs to a
    -- sibling problem of the same plan is refused here, which is what stops an
    -- edit from silently re-parenting a step under a different problem.
    select count(*)
      into v_resolved
    from public.plan_actions pa
    where pa.problem_id = v_problem_id
      and pa.id in (
        select (a.value ->> 'id')::uuid
        from jsonb_array_elements(v_actions) as a
      );

    if v_resolved <> v_posted then
      raise exception
        'update_action_plan: problem % posted % action(s), % of which belong to it',
        v_rank, v_posted, v_resolved
        using errcode = '23514';
    end if;

    delete from public.plan_actions pa
    where pa.problem_id = v_problem_id
      and pa.id not in (
        select (a.value ->> 'id')::uuid
        from jsonb_array_elements(v_actions) as a
      );

    update public.plan_problems pp
      set title     = v_problem ->> 'title',
          rationale = v_problem ->> 'rationale'
    where pp.id = v_problem_id;

    -- Renumber, pass 1 of 2. plan_actions_position_unique is
    -- `unique (problem_id, position)` and plan_actions_position_positive is
    -- `check (position > 0)`, which rules out the usual negate-then-renumber
    -- trick: the intermediate values must stay positive. A positive offset does
    -- the same job, and 1000 is safe because PROBLEM_ACTIONS_MAX bounds this
    -- collection at 5. Without this pass, removing any action other than the
    -- last one collides with a surviving row's position and raises 23505.
    update public.plan_actions pa
      set position = pa.position + 1000
    where pa.problem_id = v_problem_id;

    -- Pass 2: final positions 1..M from array order, text rewritten in the same
    -- statement.
    update public.plan_actions pa
      set position = a.ord::integer,
          content  = a.content
    from (
      select (e.value ->> 'id')::uuid as id,
             e.value ->> 'content'    as content,
             e.ord
      from jsonb_array_elements(v_actions) with ordinality as e(value, ord)
    ) as a
    where pa.id = a.id
      and pa.problem_id = v_problem_id;
  end loop;

  -- The same two passes for `rank`, for the same reason:
  -- plan_problems_rank_unique + plan_problems_rank_positive, bounded by
  -- PLAN_PROBLEMS_MAX = 8, offset by 1000.
  update public.plan_problems pp
    set rank = pp.rank + 1000
  where pp.plan_id = v_plan_id;

  update public.plan_problems pp
    set rank = p.ord::integer
  from (
    select (e.value ->> 'id')::uuid as id,
           e.ord
    from jsonb_array_elements(p_problems) with ordinality as e(value, ord)
  ) as p
  where pp.id = p.id
    and pp.plan_id = v_plan_id;

  -- Last, so that the touch trigger's stamp reflects a completed edit. The
  -- summary's bounds are enforced by action_plans_summary_bounds, which is why
  -- there is no length check for it above.
  update public.action_plans ap
    set summary = p_summary
  where ap.id = v_plan_id;
end;
$$;

comment on function public.update_action_plan(uuid, text, jsonb) is
  'Applies an owner''s whole desired state for one saved plan, atomically (FR-014). Resolves the company from the session, never from an argument. p_problems: [{id, title, rationale, actions: [{id, content}]}] — ids present survive and are rewritten, ids absent are deleted, and array order assigns rank/position. Snapshots the pre-edit plan into original_content on the FIRST edit only. Never touches plan_problem_submissions. Raises 42501 (tenancy), 22023 (floor/bound/malformed ids) or 23514 (an id that does not belong). EXECUTE is held by `authenticated` only.';

-- `revoke ... from public` alone is NOT enough, and this is the whole reason
-- 20260814134807_harden_plan_rpc_grants.sql exists: Supabase's default
-- privileges grant EXECUTE on new functions DIRECTLY to anon, authenticated and
-- service_role, and a direct grant to a named role survives a revoke aimed at
-- the PUBLIC pseudo-role. Without the `anon` revoke below, an unauthenticated
-- caller reaches the BODY of a `security definer` function that bypasses RLS on
-- every plan table — exiting through its own null-company raise rather than a
-- permission denial, which is the second layer doing the first layer's job.
revoke all on function public.update_action_plan(uuid, text, jsonb) from public, anon;
grant execute on function public.update_action_plan(uuid, text, jsonb) to authenticated;
