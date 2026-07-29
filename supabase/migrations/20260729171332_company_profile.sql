-- S-01: Company profile — owner-editable company data.
--
-- Extends the F-01 tenant record (public.companies) with the profile fields
-- FR-002/FR-003 expose to the owner. The field set is deliberately shaped as
-- company context for the S-03 action-plan prompt, so that slice inherits a
-- ready-made context block instead of needing its own migration.
--
-- Also closes two gaps the F-01 migration left behind:
--   * updated_at had a default but no BEFORE UPDATE trigger, so it was frozen
--     at insert time. This slice issues the first UPDATE against the table, so
--     it is the first to expose that.
--   * public.companies carried no explicit table privileges. Reads work on the
--     linked project today, but this slice is the first to depend on UPDATE.
--
-- Isolation is unchanged and inherited: the RLS policies from F-01 already
-- scope every verb to owner_id = auth.uid(). Nothing here widens access.

-- ---------------------------------------------------------------------------
-- Profile columns.
--
-- Nullable on purpose: handle_new_user() provisions each row blank at signup,
-- and existing rows must survive this migration. The "all four required" rule
-- is a form-level contract enforced in Zod, not a database constraint — a
-- NOT NULL here would break auto-provisioning.
-- ---------------------------------------------------------------------------
alter table public.companies
  add column industry    text,
  add column description text,
  add column location    text;

comment on column public.companies.industry is
  'Line of business. Company context for the S-03 action-plan prompt.';

comment on column public.companies.description is
  'Free-form description of the business. Company context for the S-03 action-plan prompt.';

comment on column public.companies.location is
  'Where the business operates. Company context for the S-03 action-plan prompt.';

-- ---------------------------------------------------------------------------
-- updated_at maintenance.
--
-- BEFORE UPDATE only: the column already defaults to now() on insert, so
-- firing on insert too would duplicate that for no benefit. No SECURITY
-- DEFINER — stamping a column on the row being written needs no elevated
-- privilege, and definer rights that aren't required are a liability.
-- ---------------------------------------------------------------------------
create function public.touch_updated_at()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.touch_updated_at() is
  'Generic BEFORE UPDATE trigger: stamps updated_at on every row modification.';

create trigger companies_touch_updated_at
  before update on public.companies
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Explicit table privileges.
--
-- RLS decides WHICH rows a caller may touch; grants decide whether the verb is
-- permitted at all. Stating them here makes the requirement explicit in the
-- repo rather than dependent on project-level default-privilege behaviour
-- (see supabase/config.toml: new entities are not auto-exposed when unset).
--
-- Deliberately NOT granted to anon: the public submission form (S-06) will get
-- its own scoped path rather than reaching this table directly.
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.companies to authenticated;
