-- ---------------------------------------------------------------------------
-- Narrow the owner write surface on public.companies
--
-- Implementation-review finding F3
-- (context/changes/company-profile/reviews/impl-review.md).
--
-- 20260729171332_company_profile.sql granted `insert, update` table-wide to
-- `authenticated`. Two problems:
--
--   * `insert` is granted but nothing inserts. Provisioning is trigger-only
--     (handle_new_user), and account creation is the exclusive way a tenant row
--     comes into existence. An unused verb on the tenant anchor table.
--
--   * `update` is table-wide, and `companies_update_own` pins only `owner_id`
--     in its `with check`. So an owner holding nothing but an anon-key session
--     can PATCH /companies and rewrite their own `id` and `created_at`. RLS
--     cannot express this: a row policy decides WHICH rows, never WHICH
--     columns. Column-level grants are the only mechanism that can.
--
--     `id` matters beyond tidiness. S-06 keys the public submission URL on the
--     company identifier, and PRD FR-004 / the NFR require that identifier to
--     be unpredictable — a self-chosen id (all-zeros, or one guessed from
--     another tenant) defeats that directly. A rewritten id would also silently
--     orphan every future company_id foreign key.
--
-- Least privilege: the owner may write the four profile fields and nothing
-- else. `companies_insert_own` is deliberately LEFT IN PLACE — it costs
-- nothing and remains the second layer if the insert privilege is ever
-- restored.
--
-- Forward-only: compensates the grant in 20260729171332_company_profile.sql
-- rather than editing it.
-- ---------------------------------------------------------------------------

revoke insert, update on public.companies from authenticated;

grant update (name, industry, description, location)
  on public.companies to authenticated;
