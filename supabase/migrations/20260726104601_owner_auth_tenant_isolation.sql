-- F-01: Owner auth + per-company tenant isolation foundation.
-- Establishes the reusable isolation contract inherited by all downstream
-- slices (S-01, S-02, S-03, S-04, S-06):
--   * one companies row per auth user (flat model: 1 account = 1 company)
--   * RLS keyed on auth.uid() enforced at the database layer
--   * public.current_company_id() helper for downstream tables' policies
--   * a trigger that auto-provisions the company row on user signup
--
-- Isolation is enforced by RLS via the user-session (anon-key) client. The
-- service-role client bypasses RLS and must never be used for owner-facing reads.

-- ---------------------------------------------------------------------------
-- companies: the tenant record
-- ---------------------------------------------------------------------------
create table public.companies (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null unique references auth.users (id) on delete cascade,
  name       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.companies is
  'One company per owner (auth user). owner_id is the isolation anchor; UNIQUE enforces the flat 1 account = 1 company model.';

-- ---------------------------------------------------------------------------
-- Row Level Security: an owner may only touch their own company row
-- ---------------------------------------------------------------------------
alter table public.companies enable row level security;

create policy "companies_select_own"
  on public.companies for select
  to authenticated
  using (owner_id = (select auth.uid()));

create policy "companies_insert_own"
  on public.companies for insert
  to authenticated
  with check (owner_id = (select auth.uid()));

create policy "companies_update_own"
  on public.companies for update
  to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy "companies_delete_own"
  on public.companies for delete
  to authenticated
  using (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- current_company_id(): the reusable isolation primitive
-- Downstream tables (submissions, plans, ...) key their RLS on
--   company_id = public.current_company_id()
-- SECURITY DEFINER so it can read companies regardless of the caller's RLS;
-- it only ever returns the CALLER's own company (via auth.uid()), so it does
-- not widen access. Explicit empty search_path prevents object-resolution
-- hijacking; all referenced objects are schema-qualified.
-- ---------------------------------------------------------------------------
create function public.current_company_id()
  returns uuid
  language sql
  security definer
  stable
  set search_path = ''
as $$
  select id from public.companies where owner_id = (select auth.uid())
$$;

comment on function public.current_company_id() is
  'Returns the calling authenticated user''s company id, or NULL. Reusable predicate for downstream tenant-table RLS policies.';

revoke all on function public.current_company_id() from public;
grant execute on function public.current_company_id() to authenticated;

-- ---------------------------------------------------------------------------
-- Auto-provisioning: create the company row the instant an auth user exists,
-- enforced in the database so no application code path can forget it.
-- ---------------------------------------------------------------------------
create function public.handle_new_user()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  insert into public.companies (owner_id) values (new.id);
  return new;
end;
$$;

comment on function public.handle_new_user() is
  'Provisions exactly one companies row for each new auth.users row.';

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
