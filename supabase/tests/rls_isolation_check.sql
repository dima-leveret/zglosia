-- F-01 criterion 1.2 — SQL-level RLS isolation check for public.companies.
--
-- Run against a database that already has the F-01 migration applied:
--   psql "$SUPABASE_DB_URL" -f supabase/tests/rls_isolation_check.sql
-- (or paste into the Supabase SQL editor). The whole thing runs inside a
-- transaction that ROLLBACKs, so it leaves no data behind. Any failed
-- assertion raises an exception and aborts — no exception means it passed.

begin;

-- Two synthetic owners. Inserting into auth.users fires handle_new_user(),
-- which auto-provisions exactly one companies row per user.
insert into auth.users (instance_id, id, aud, role, email)
values
  ('00000000-0000-0000-0000-000000000000',
   '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated',
   'owner-a@example.test'),
  ('00000000-0000-0000-0000-000000000000',
   '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated',
   'owner-b@example.test');

-- The trigger provisioned one company per owner (checked as superuser, pre-RLS).
do $$
begin
  if (select count(*) from public.companies
        where owner_id in ('11111111-1111-1111-1111-111111111111',
                           '22222222-2222-2222-2222-222222222222')) <> 2 then
    raise exception 'FAIL: trigger did not provision one company per owner';
  end if;
end $$;

-- Simulate owner A's authenticated session (RLS now applies).
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

do $$
begin
  -- A sees exactly one company...
  if (select count(*) from public.companies) <> 1 then
    raise exception 'FAIL: owner A should see exactly 1 company, saw %',
      (select count(*) from public.companies);
  end if;
  -- ...and it is A's own.
  if (select owner_id from public.companies)
     <> '11111111-1111-1111-1111-111111111111' then
    raise exception 'FAIL: owner A saw a company that is not theirs';
  end if;
  -- The reusable helper resolves A's company id.
  if public.current_company_id() is null then
    raise exception 'FAIL: current_company_id() returned NULL for owner A';
  end if;
  -- Cross-tenant read denial: A cannot see B's row by any means.
  if exists (select 1 from public.companies
               where owner_id = '22222222-2222-2222-2222-222222222222') then
    raise exception 'ISOLATION BREACH: owner A can read owner B''s company';
  end if;
end $$;

reset role;

select 'PASS: RLS denies cross-tenant reads; helper + trigger behave' as result;

rollback;
