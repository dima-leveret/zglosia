-- ---------------------------------------------------------------------------
-- Harden company isolation: remove owner-initiated DELETE
--
-- Implementation-review finding F3
-- (context/changes/owner-auth-tenant-isolation/reviews/impl-review.md).
--
-- `companies_delete_own` plus the `delete` grant let an owner erase their own
-- tenant row straight through PostgREST with nothing but their anon-key
-- session. Nothing ever re-creates it: `on_auth_user_created` fires only on
-- `after insert on auth.users`, and no application code inserts a company. The
-- owner is then stuck on the "no company is provisioned" branch permanently.
--
-- No product feature needs this privilege. Account deletion runs through
-- `auth.admin.deleteUser` and relies on `companies.owner_id`'s
-- `on delete cascade` — a system-level FK action, unaffected by grants or row
-- policies. Least privilege: take DELETE away from `authenticated`.
--
-- Forward-only: this compensates the DELETE policy created in
-- 20260726104601_owner_auth_tenant_isolation.sql and the grant in
-- 20260729171332_company_profile.sql rather than editing either.
-- ---------------------------------------------------------------------------

drop policy if exists "companies_delete_own" on public.companies;

revoke delete on public.companies from authenticated;
