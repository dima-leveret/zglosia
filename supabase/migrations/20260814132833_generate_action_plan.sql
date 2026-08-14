-- S-03: Generate action plan — the product's north star (US-01, FR-011, FR-012).
--
-- Five tables, one cap trigger and one save RPC. The shape follows the template
-- 20260804171802_submission_intake.sql declared for exactly this slice:
-- `revoke all` first, then narrowest verb and narrowest column set, then RLS
-- policies whose predicates wrap public.current_company_id() in a subselect so
-- the helper is evaluated once per statement (InitPlan) rather than once per row.
--
-- Two guarantees are enforced HERE and would hold against a direct PostgREST
-- call with a leaked anon key, not merely against the well-behaved Server
-- Action:
--
--   1. GROUNDING (the anti-hallucination NFR). save_action_plan() inserts
--      citations with `insert ... select ... where company_id = <caller's>`, so
--      a citation naming a submission the caller does not own simply produces
--      no row — and the function then compares the row count it asked for
--      against the row count it got and aborts on a mismatch. A fabricated
--      citation cannot be persisted, no matter what the model returned or what
--      a tampered client posted back.
--
--   2. SPEND. A plan_generations row is written BEFORE the model is called, and
--      its BEFORE INSERT trigger raises PT429 past the daily cap. Because
--      review-then-save makes generating and saving separate acts, the cap must
--      bind the GENERATION: capping saves would leave generate-and-discard —
--      the exact loop a stuck retry falls into — completely unbounded.
--
-- Scope is deliberately narrow. FR-013 (list plans) and FR-014 (edit/delete
-- plans) are S-04, so there is no update grant, no delete grant, no updated_at
-- column and no touch trigger anywhere in this file. That absence is a
-- decision, not an oversight — the same call submission_intake made for FR-010.

-- ---------------------------------------------------------------------------
-- action_plans: the saved plan header, one row per generated-and-accepted plan.
--
-- `summary` is FR-011's first half — the ranked overview of recurring problems
-- in prose. The ranking itself lives in plan_problems.rank; this is the
-- narrative the owner reads first.
--
-- `on delete cascade` on company_id is required, not incidental: account
-- erasure works by deleting the auth.users row, which cascades to companies.
-- Without the cascade here that delete fails on the foreign key and the RODO
-- erasure path (src/lib/account-deletion.ts) breaks outright. Plans are erased
-- with everything else — the correct reading of the NFR, and the same
-- conclusion submission_intake reached for submissions.
-- ---------------------------------------------------------------------------
create table public.action_plans (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  summary    text not null,
  created_at timestamptz not null default now(),

  -- Zod is not a boundary — a direct PostgREST call skips it entirely — so the
  -- bounds live here too, mirroring src/lib/plan-schema.ts. Same reasoning as
  -- submissions_content_bounds (20260804183507); the regex matches JavaScript's
  -- .trim() semantics rather than approximating them with btrim(), which strips
  -- spaces only (20260804183633).
  constraint action_plans_summary_bounds check (
    char_length(summary) <= 4000
    and summary ~ '[^[:space:]]'
  )
);

comment on table public.action_plans is
  'A saved action plan for one company (FR-012). company_id is the isolation anchor; RLS scopes reads to public.current_company_id(). Written only through public.save_action_plan().';

alter table public.action_plans enable row level security;

-- ---------------------------------------------------------------------------
-- plan_problems: one recurring problem the model surfaced, with its position in
-- the priority order FR-011 requires.
--
-- `unique (plan_id, rank)` is what makes "uszeregowanych według wagi" (PRD
-- §Business Logic) a property of the data rather than of whatever order the
-- reader happens to select in. Two problems cannot claim the same position.
-- ---------------------------------------------------------------------------
create table public.plan_problems (
  id        uuid primary key default gen_random_uuid(),
  plan_id   uuid not null references public.action_plans (id) on delete cascade,
  rank      integer not null,
  title     text not null,
  rationale text not null,

  constraint plan_problems_rank_positive check (rank > 0),
  constraint plan_problems_rank_unique unique (plan_id, rank),
  constraint plan_problems_title_bounds check (
    char_length(title) <= 200
    and title ~ '[^[:space:]]'
  ),
  constraint plan_problems_rationale_bounds check (
    char_length(rationale) <= 2000
    and rationale ~ '[^[:space:]]'
  )
);

comment on table public.plan_problems is
  'One recurring problem inside a saved plan. rank carries the priority ordering FR-011 requires and is unique per plan.';

alter table public.plan_problems enable row level security;

-- ---------------------------------------------------------------------------
-- plan_problem_submissions: THIS TABLE IS THE NFR.
--
-- "Wygenerowany plan działań jest wyraźnie ugruntowany w faktycznych
-- zgłoszeniach firmy — każdy wyłoniony problem da się powiązać z realnymi
-- zgłoszeniami, a nie ze zmyślonymi treściami." A foreign key to an actual
-- submissions row is the strongest available form of that sentence: a problem
-- whose support is invented has nothing to point at.
--
-- `on delete cascade` on submission_id is deliberate and has a consequence
-- worth stating plainly. When an owner deletes a submission (FR-009) its
-- citations vanish rather than dangling, and a saved problem can legitimately
-- end up with none. The plan records what was true when it was generated —
-- "grounded" is a statement about generation time, not forever.
-- ---------------------------------------------------------------------------
create table public.plan_problem_submissions (
  problem_id    uuid not null references public.plan_problems (id) on delete cascade,
  submission_id uuid not null references public.submissions (id) on delete cascade,

  primary key (problem_id, submission_id)
);

comment on table public.plan_problem_submissions is
  'Citations: which real submissions a plan problem was drawn from. The anti-hallucination NFR as foreign keys. Rows can only be written by public.save_action_plan(), which refuses citations outside the caller''s own company.';

alter table public.plan_problem_submissions enable row level security;

-- The PK covers problem_id, but the ON DELETE CASCADE arriving from
-- public.submissions scans on submission_id — unindexed, that is a sequential
-- scan of every citation in the table on each submission delete.
create index plan_problem_submissions_submission_idx
  on public.plan_problem_submissions (submission_id);

-- ---------------------------------------------------------------------------
-- plan_actions: the concrete improvement steps.
--
-- They hang off a problem, not off the plan. That is what makes "planu działań
-- — uporządkowanej listy konkretnych kroków usprawniających, POWIĄZANYCH z
-- wyłonionymi problemami" (PRD §Business Logic) structural rather than a
-- convention the prompt is asked to observe.
-- ---------------------------------------------------------------------------
create table public.plan_actions (
  id         uuid primary key default gen_random_uuid(),
  problem_id uuid not null references public.plan_problems (id) on delete cascade,
  position   integer not null,
  content    text not null,

  constraint plan_actions_position_positive check (position > 0),
  constraint plan_actions_position_unique unique (problem_id, position),
  constraint plan_actions_content_bounds check (
    char_length(content) <= 1000
    and content ~ '[^[:space:]]'
  )
);

comment on table public.plan_actions is
  'Concrete improvement steps, attached to the problem they address rather than to the plan, so FR-011''s "powiązanych z wyłonionymi problemami" is structural.';

alter table public.plan_actions enable row level security;

-- ---------------------------------------------------------------------------
-- plan_generations: the spend ledger.
--
-- One row per generation ATTEMPT, written before the model is called and kept
-- whether that call goes on to succeed, fail or time out. Recording only
-- successes would mean a caller looping on a request that dies mid-flight is
-- never counted and the cap never binds — which is the runaway this table
-- exists to prevent.
--
-- No status column, no cost column, no reference to the resulting plan.
-- Anything more would be observability tooling, which the plan parks.
-- ---------------------------------------------------------------------------
create table public.plan_generations (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  created_at timestamptz not null default now()
);

comment on table public.plan_generations is
  'One row per action-plan generation attempt, written BEFORE the model call. Feeds enforce_plan_generation_rate(); the row is kept even when the attempt fails, which is what makes the cap bind.';

alter table public.plan_generations enable row level security;

-- Serves the trigger's count predicate exactly.
create index plan_generations_company_created_idx
  on public.plan_generations (company_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Listing index for action_plans.
--
-- Matches the RLS predicate's leading column and the newest-first order S-04
-- will list in. `id desc` is a tiebreaker, not decoration: plans saved in the
-- same statement share created_at, and without it the order is non-deterministic
-- — the same reasoning as submissions_company_created_idx.
-- ---------------------------------------------------------------------------
create index action_plans_company_created_idx
  on public.action_plans (company_id, created_at desc, id desc);

-- ---------------------------------------------------------------------------
-- Privileges.
--
-- Load-bearing, and easy to mistake for redundancy: the linked project predates
-- the current Supabase default and DOES auto-expose new tables, so the `create
-- table` statements above may already have granted ALL to anon and
-- authenticated via default privileges — before a single grant below runs.
-- Without this revoke, "writes are RPC-only" and "anon gets nothing" are
-- silently void on that database while reading correctly in the repo.
-- Do not delete this as a no-op (20260804171802_submission_intake.sql:59-71).
-- ---------------------------------------------------------------------------
revoke all on public.action_plans             from anon, authenticated;
revoke all on public.plan_problems            from anon, authenticated;
revoke all on public.plan_problem_submissions from anon, authenticated;
revoke all on public.plan_actions             from anon, authenticated;
revoke all on public.plan_generations         from anon, authenticated;

-- Read-only for the owner across the four plan tables. There is deliberately NO
-- insert grant on any of them: every write goes through save_action_plan(),
-- which is `security definer` and therefore does not need the calling role to
-- hold the privilege. Granting insert "because the table has rows to insert"
-- would hand a direct PostgREST caller a way around the grounding check that is
-- the entire point of the RPC.
--
-- No update and no delete anywhere. S-04 grants what FR-014 needs; this slice
-- does not pre-grant it (context/foundation/lessons.md — narrowest verb).
grant select on public.action_plans             to authenticated;
grant select on public.plan_problems            to authenticated;
grant select on public.plan_problem_submissions to authenticated;
grant select on public.plan_actions             to authenticated;

-- The ledger is the one table the application writes directly, and it writes
-- exactly one column. Narrowest column set: a table-wide insert grant would let
-- an owner supply their own `created_at` and backdate every row out of the
-- trigger's 24-hour window, which defeats the cap entirely.
grant select on public.plan_generations to authenticated;
grant insert (company_id) on public.plan_generations to authenticated;

-- `anon` gets nothing at all on any of these tables. The public form (S-06) is
-- the product's only unauthenticated surface and it does not touch plans.

-- ---------------------------------------------------------------------------
-- Row Level Security.
--
-- action_plans and plan_generations carry company_id and predicate on it
-- directly. The other three are one and two joins removed, so they predicate on
-- an EXISTS walking back up the parent chain — each one wrapping
-- current_company_id() in a subselect for the same InitPlan reason the S-02
-- policies document.
--
-- Reads only. There is no insert/update/delete policy on the four plan tables
-- because the corresponding grants do not exist: a policy without a grant is
-- decoration, and would suggest a write path that is not actually open.
-- ---------------------------------------------------------------------------
create policy "action_plans_select_own"
  on public.action_plans for select
  to authenticated
  using (company_id = (select public.current_company_id()));

create policy "plan_problems_select_own"
  on public.plan_problems for select
  to authenticated
  using (
    exists (
      select 1
      from public.action_plans ap
      where ap.id = plan_problems.plan_id
        and ap.company_id = (select public.current_company_id())
    )
  );

create policy "plan_actions_select_own"
  on public.plan_actions for select
  to authenticated
  using (
    exists (
      select 1
      from public.plan_problems pp
        join public.action_plans ap on ap.id = pp.plan_id
      where pp.id = plan_actions.problem_id
        and ap.company_id = (select public.current_company_id())
    )
  );

create policy "plan_problem_submissions_select_own"
  on public.plan_problem_submissions for select
  to authenticated
  using (
    exists (
      select 1
      from public.plan_problems pp
        join public.action_plans ap on ap.id = pp.plan_id
      where pp.id = plan_problem_submissions.problem_id
        and ap.company_id = (select public.current_company_id())
    )
  );

create policy "plan_generations_select_own"
  on public.plan_generations for select
  to authenticated
  using (company_id = (select public.current_company_id()));

-- The one insert policy in this migration. It pins the ledger row to the
-- caller's own company so an owner cannot spend another tenant's daily budget
-- for them — the count the trigger runs is per company_id, so an unpinned
-- insert would be a denial-of-service against a stranger's generate button.
create policy "plan_generations_insert_own"
  on public.plan_generations for insert
  to authenticated
  with check (company_id = (select public.current_company_id()));

-- ---------------------------------------------------------------------------
-- enforce_plan_generation_rate(): the spend bound.
--
-- A BEFORE INSERT trigger rather than a clause in the policy's `with check`,
-- for the two reasons enforce_form_submission_rate() records
-- (20260809151843_public_submission_form.sql:94-111): a `with check` subquery
-- counting rows on the table being inserted into has murky visibility
-- semantics, and a trigger can raise a DISTINCT sqlstate so the Server Action
-- can tell "you are being throttled" from "something failed" without matching
-- on an error string.
--
-- This is the layer that actually bounds the spend: it holds against a caller
-- who skips the page and posts straight at PostgREST with the anon key and
-- their own JWT.
--
-- The count is served by plan_generations_company_created_idx above.
-- ---------------------------------------------------------------------------
create function public.enforce_plan_generation_rate()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  recent_count integer;
begin
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
  'Caps action-plan generation attempts at 10 per company per day, raising sqlstate PT429 (PostgREST -> HTTP 429). Bounds the paid model call behind the Generate button.';

create trigger enforce_plan_generation_rate
  before insert on public.plan_generations
  for each row execute function public.enforce_plan_generation_rate();

-- ---------------------------------------------------------------------------
-- save_action_plan(): the only write path into the four plan tables.
--
-- WHY AN RPC AT ALL: supabase-js has no transaction API. A saved plan spans
-- four tables, and a sequence of separate PostgREST inserts can leave a header
-- with no problems, or a problem with no citations, if any one of them fails
-- midway. One function call is one transaction.
--
-- WHY IT IS THE GROUNDING BOUNDARY: the citation insert is
-- `insert ... select ... from public.submissions where company_id = <caller's>`,
-- so an id naming a submission the caller does not own contributes no row. The
-- function then compares the number of DISTINCT ids it was handed against the
-- number of rows that actually landed and raises on any difference. That
-- turns "the client posted a citation for a submission it does not own" into an
-- aborted transaction rather than a silently thinner plan — and it holds
-- whether the bad id came from a hallucinating model, a bug in the mapping
-- code, or a hand-crafted POST.
--
-- p_problems is a jsonb array whose element keys match the verified plan
-- artifact the Server Action holds, so savePlan can pass its parsed object
-- straight through:
--   [{ "title": text, "rationale": text,
--      "submissionIds": [uuid, ...], "actions": [text, ...] }]
-- Order in the array IS the priority order; `rank` is assigned from it here
-- rather than trusted from the payload, so the ordering cannot arrive
-- duplicated or with gaps.
--
-- The company is resolved from the session via current_company_id() and is
-- NEVER taken from an argument — the invariant every Server Action in this
-- codebase documents. security definer + `set search_path = ''` +
-- revoke-from-public + targeted grant mirrors current_company_id()
-- (20260726104601_owner_auth_tenant_isolation.sql:61-75).
-- ---------------------------------------------------------------------------
create function public.save_action_plan(p_summary text, p_problems jsonb)
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

  -- A plan with zero problems is not a plan. The Server Action already refuses
  -- to return one; this is the independent second layer, not the first.
  if jsonb_typeof(p_problems) <> 'array' or jsonb_array_length(p_problems) = 0 then
    raise exception 'save_action_plan: a plan must carry at least one problem'
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
  'Saves one action plan atomically (FR-012). Resolves the company from the session, never from an argument, and refuses any citation that does not resolve to a submission of that company — the anti-hallucination NFR as a database guarantee. p_problems: [{title, rationale, submissionIds[], actions[]}], array order is the priority order.';

revoke all on function public.save_action_plan(text, jsonb) from public;
grant execute on function public.save_action_plan(text, jsonb) to authenticated;
