-- S-02: Submission intake — the customer-submission store.
--
-- The first tenant table to key its RLS on public.current_company_id(), the
-- helper F-01 built for exactly this purpose and that nothing consumed until
-- now. The isolation contract established here is what S-03 (action plans),
-- S-04 and S-06 inherit, so the policy shape below is a template, not a
-- one-off.
--
-- Scope is deliberately narrow (FR-007 / FR-008 / FR-009): read, insert, and
-- hard-delete for the owner. FR-010 (edit a submission) is parked as
-- nice-to-have in the PRD — editing a customer's own words is the thing the
-- product says not to do — so there is no update policy, no update grant, no
-- updated_at column and no touch trigger anywhere in this file. That absence
-- is a decision, not an oversight.

-- ---------------------------------------------------------------------------
-- submission_source: where a submission came from.
--
-- An enum rather than a text column with a check constraint, because it
-- generates as a `'manual' | 'form'` union in database.types.ts instead of a
-- bare `string` — the discriminator the list UI branches on is then typed all
-- the way from Postgres to the badge. 'form' has no writer until S-06 ships
-- the public form; it is declared now so the type is stable across slices.
-- ---------------------------------------------------------------------------
create type public.submission_source as enum ('manual', 'form');

comment on type public.submission_source is
  'Origin of a submission: manual = entered by the owner, form = submitted by a customer through the public form (S-06).';

-- ---------------------------------------------------------------------------
-- submissions: raw customer feedback, one row per submission.
--
-- Content only — no author, no occurred-on date, no owner category. The
-- content field is the input to the S-03 action-plan prompt; everything else
-- is provenance.
--
-- `on delete cascade` on company_id is required, not incidental: account
-- erasure works by deleting the auth.users row, which cascades to companies.
-- Without the cascade here that delete fails on the foreign key and the RODO
-- erasure path breaks outright. The consequence is that deleteAccount now
-- destroys submissions too — intended, and the correct reading of the NFR.
-- ---------------------------------------------------------------------------
create table public.submissions (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  content    text not null,
  source     public.submission_source not null,
  created_at timestamptz not null default now()
);

comment on table public.submissions is
  'Customer submissions for one company. company_id is the isolation anchor; RLS scopes every verb to public.current_company_id().';

comment on column public.submissions.source is
  'Origin marking required by FR-008. Pinned by the RLS with check per role, so it cannot be forged by the writer.';

alter table public.submissions enable row level security;

-- ---------------------------------------------------------------------------
-- Privileges.
--
-- Load-bearing, and easy to mistake for redundancy: the linked project
-- predates the current Supabase default and DOES auto-expose new tables, so
-- the `create table` above may already have granted ALL to anon and
-- authenticated via default privileges — before a single grant below runs.
-- Without this revoke, the column-scoped insert, the deliberate absence of any
-- update privilege, and "nothing for anon" are all silently void on that
-- database while looking correct in the repo. Revoking first makes the grant
-- block the authoritative privilege set in EVERY environment.
-- Do not delete this as a no-op.
-- ---------------------------------------------------------------------------
revoke all on public.submissions from anon, authenticated;

-- Narrowest verb AND narrowest column set (context/foundation/lessons.md). A
-- table-wide insert grant would let an owner choose their own `id` and
-- `created_at` — the same class of hole review finding F3 found on
-- public.companies. RLS cannot express column scope: a row policy decides
-- WHICH rows, never WHICH columns. Only the grant can.
grant select, delete on public.submissions to authenticated;
grant insert (company_id, content, source) on public.submissions to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security: an owner may only touch their own company's submissions.
--
-- Every predicate wraps the helper in a subselect, exactly as the F-01
-- policies wrap auth.uid(). That forces an InitPlan so the function is
-- evaluated once per statement instead of once per row — this is the one table
-- in the product designed to grow unbounded, and every downstream tenant table
-- copies this policy shape.
--
-- Nothing is granted or policied for `anon` here. S-06 opens the public form
-- with its own scoped insert policy; this slice deliberately leaves that
-- surface closed.
-- ---------------------------------------------------------------------------
create policy "submissions_select_own"
  on public.submissions for select
  to authenticated
  using (company_id = (select public.current_company_id()));

-- The `source` pin is what makes FR-008's origin marking a database guarantee
-- rather than an application convention: an owner's session cannot mint a row
-- claiming to be a customer's form submission, not even through a raw
-- PostgREST call with the anon key. S-06 adds the symmetric `anon` policy
-- pinning 'form'.
create policy "submissions_insert_own_manual"
  on public.submissions for insert
  to authenticated
  with check (
    company_id = (select public.current_company_id())
    and source = 'manual'
  );

create policy "submissions_delete_own"
  on public.submissions for delete
  to authenticated
  using (company_id = (select public.current_company_id()));

-- ---------------------------------------------------------------------------
-- List index: matches the submissions page query's filter and sort exactly, so
-- the capped read stays an index scan regardless of how large the table grows.
--
-- `id desc` is a tiebreaker, not decoration: rows inserted in the same
-- statement share created_at, and without it both the list order and the test
-- fixtures seeded in one batch are non-deterministic.
-- ---------------------------------------------------------------------------
create index submissions_company_created_idx
  on public.submissions (company_id, created_at desc, id desc);
