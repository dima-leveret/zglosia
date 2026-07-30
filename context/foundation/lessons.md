# Lessons Learned

> Append-only register of recurring rules and patterns. Re-read at start by /10x-frame, /10x-research, /10x-plan, /10x-plan-review, /10x-implement, /10x-impl-review.

## Grants ship in the migration that creates the object

- **Context**: `supabase/migrations/20260726104601_owner_auth_tenant_isolation.sql:15-50` — F-01 created `public.companies` with RLS enabled and four policies, but no table-level `grant`. Only `current_company_id()` got one.
- **Problem**: With `auto_expose_new_tables` unset (the current Supabase default), new entities are not auto-exposed to `authenticated`, so on a fresh `supabase db reset` every owner read fails with `42501: permission denied`. RLS decides *which rows*; grants decide whether the verb is allowed at all. The gap stayed invisible for three days because the linked project predates that default — and the automated criterion `supabase db reset` was ticked without ever being run against an empty database.
- **Rule**: A migration must leave the database in a working state on its own. Grants belong in the same migration as the `create table`, and any "migration applies cleanly" criterion is only tickable after an actual `supabase db reset` from empty — never inferred from the linked project working.
- **Applies to**: Every `supabase/migrations/*.sql`, and any plan phase whose Automated Verification includes a migration command.

## A migration in the repo is not a migration in the database

- **Context**: `supabase/migrations/20260730104500_harden_company_delete.sql` and `20260730104501_handle_new_user_idempotent.sql` — written and committed as fixes for the F-01 implementation review, then never pushed.
- **Problem**: `supabase migration list --linked` showed both with an empty remote column a full day later. The F3 bug they were written to close — an owner erasing their own tenant row through PostgREST and stranding themselves — was still live in production while the review that found it was marked resolved. It surfaced only because a later review ran the integration suite, which failed asserting `42501` on a privilege the live database still granted. The tests were right; the database was behind.
- **Rule**: A review finding is not closed when the migration is committed — it is closed when `supabase migration list --linked` shows it applied remotely. Any change that writes a migration must end with `supabase db push` plus that listing as evidence, and a review that fixes a DB-layer finding must verify remote state, not repo state.
- **Applies to**: Every `supabase/migrations/*.sql`, every implementation-review triage that produces a migration, and any plan phase whose Automated Verification includes a migration command.

## Grants: narrowest verb, and narrowest column set

- **Context**: `supabase/migrations/20260729171332_company_profile.sql:77` — `grant select, insert, update, delete on public.companies to authenticated`, written exactly as the plan specified.
- **Problem**: Three of those four verbs were wrong. `delete` let an owner erase their own tenant row (removed later by a compensating migration); `insert` was granted although provisioning is trigger-only and nothing inserts; and table-wide `update` let an owner with nothing but an anon-key session rewrite their own `id` and `created_at` — because `companies_update_own`'s `with check` pins only `owner_id`. RLS cannot express column scope: a row policy decides WHICH rows, never WHICH columns. The `id` case is not cosmetic — S-06 keys the public form URL on it and FR-004 requires it unpredictable.
- **Rule**: Grant only the verbs an application code path actually exercises, and when a table has columns the owner must not rewrite, grant `update (col, col, …)` rather than table-wide `update`. Deriving the grant from "what the table has" instead of "what the code does" is how unused and over-broad privileges get shipped.
- **Applies to**: Every `grant` in `supabase/migrations/*.sql`, and any plan that specifies table privileges as part of a schema phase.
