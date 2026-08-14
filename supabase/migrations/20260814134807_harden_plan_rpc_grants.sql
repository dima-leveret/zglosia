-- Compensating migration for 20260814132833_generate_action_plan.sql.
--
-- That file ends with `revoke all on function public.save_action_plan(text,
-- jsonb) from public` followed by a targeted grant to `authenticated`, and its
-- comment claims the RPC is therefore callable by owners only. The Phase 2
-- contract suite (tests/plans.test.ts) proved otherwise: a bare anon-key client
-- reaches the function BODY, and the error it gets back is the function's own
-- raise —
--
--   {"code":"42501","message":"save_action_plan: no company for the calling user"}
--
-- — not "permission denied for function". So `anon` held EXECUTE the whole time.
--
-- WHY THE REVOKE MISSED IT: Supabase's default privileges grant EXECUTE on new
-- functions DIRECTLY to anon, authenticated and service_role. `revoke ... from
-- public` removes only the PUBLIC pseudo-role's privilege, and a direct grant to
-- a named role survives it untouched. This is the function-level twin of the
-- auto-expose-tables trap that the same migration guards against for TABLES with
-- its `revoke all on <table> from anon, authenticated` block — the table half was
-- handled, the function half was not.
--
-- Nothing was exploitable: save_action_plan resolves the company from
-- current_company_id(), which is null for a caller with no JWT, and raises before
-- writing a row. That null check is why every grounding assertion in the suite
-- still held. But it was the SECOND layer doing the first layer's job, and
-- context/foundation/lessons.md ("Grants: narrowest verb, and narrowest column
-- set") is precisely about not shipping a privilege that no code path exercises.
-- An unauthenticated role should not be able to enter a `security definer`
-- function that bypasses RLS on public.submissions, however it exits.
--
-- current_company_id() is left alone deliberately: it is `stable` and returns
-- only the caller's own company id (null for anon), so it discloses nothing, and
-- the public form path (S-06) runs as anon through PostgREST where an unexpected
-- revoke would be a regression risk for no gain.

revoke all on function public.save_action_plan(text, jsonb) from anon;

comment on function public.save_action_plan(text, jsonb) is
  'Saves one action plan atomically (FR-012). Resolves the company from the session, never from an argument, and refuses any citation that does not resolve to a submission of that company — the anti-hallucination NFR as a database guarantee. p_problems: [{title, rationale, submissionIds[], actions[]}], array order is the priority order. EXECUTE is held by `authenticated` only: the grant to `anon` that Supabase default privileges create was revoked in 20260814134807_harden_plan_rpc_grants.sql.';
