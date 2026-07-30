-- ---------------------------------------------------------------------------
-- Make company auto-provisioning idempotent
--
-- Implementation-review finding F6
-- (context/changes/owner-auth-tenant-isolation/reviews/impl-review.md).
--
-- `handle_new_user()` is an AFTER INSERT trigger on auth.users, so anything it
-- raises aborts the enclosing INSERT. `companies.owner_id` is unique, and the
-- insert had no `on conflict`, so a replayed auth.users row — a re-import, a
-- restore, a manual backfill — would abort signup with Supabase's opaque
-- "500: Database error saving new user". The blast radius is every signup, not
-- just the conflicting one.
--
-- Provisioning is a convenience, not a security control (RLS is), so it should
-- degrade rather than block account creation.
--
-- Forward-only: replaces the function body created in
-- 20260726104601_owner_auth_tenant_isolation.sql. The trigger itself keeps
-- pointing at the same function and needs no change.
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  insert into public.companies (owner_id)
  values (new.id)
  on conflict (owner_id) do nothing;
  return new;
end;
$$;

comment on function public.handle_new_user() is
  'Provisions exactly one companies row for each new auth.users row. Idempotent: a duplicate owner_id is a no-op rather than a failed signup.';
