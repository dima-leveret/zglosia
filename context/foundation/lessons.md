# Lessons Learned

> Append-only register of recurring rules and patterns. Re-read at start by /10x-frame, /10x-research, /10x-plan, /10x-plan-review, /10x-implement, /10x-impl-review.

## Grants ship in the migration that creates the object

- **Context**: `supabase/migrations/20260726104601_owner_auth_tenant_isolation.sql:15-50` — F-01 created `public.companies` with RLS enabled and four policies, but no table-level `grant`. Only `current_company_id()` got one.
- **Problem**: With `auto_expose_new_tables` unset (the current Supabase default), new entities are not auto-exposed to `authenticated`, so on a fresh `supabase db reset` every owner read fails with `42501: permission denied`. RLS decides *which rows*; grants decide whether the verb is allowed at all. The gap stayed invisible for three days because the linked project predates that default — and the automated criterion `supabase db reset` was ticked without ever being run against an empty database.
- **Rule**: A migration must leave the database in a working state on its own. Grants belong in the same migration as the `create table`, and any "migration applies cleanly" criterion is only tickable after an actual `supabase db reset` from empty — never inferred from the linked project working.
- **Applies to**: Every `supabase/migrations/*.sql`, and any plan phase whose Automated Verification includes a migration command.
