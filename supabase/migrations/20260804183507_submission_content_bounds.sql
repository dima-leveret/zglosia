-- Bound submissions.content in the database.
--
-- Implementation-review finding F2
-- (context/changes/submission-intake/reviews/impl-review.md).
--
-- 20260804171802_submission_intake.sql declared `content text not null` with no
-- length or emptiness constraint. The 2000-character cap and the
-- reject-whitespace-only rule lived entirely in Zod (src/lib/validation.ts) and
-- in the textarea's maxLength — both client-reachable code paths, neither of
-- them a boundary.
--
-- The bypass is direct: an owner holding the public anon key and their own JWT
-- can POST /rest/v1/submissions with a multi-megabyte `content` on their own
-- company_id. The column-scoped insert grant permits the column, and the RLS
-- `with check` only pins company_id and source — nothing there looks at length.
-- The same call inserts a whitespace-only row.
--
-- That matters because the cap is not cosmetic. validation.ts documents it as
-- an S-03 prompt-token budget: the action-plan prompt's ceiling is the number
-- of submissions times this bound, so an unbounded row is a direct cost and
-- latency vector on plan generation, and a blank row is prompt noise that the
-- owner never intentionally created.
--
-- This is the generalized form of the rule context/foundation/lessons.md
-- already records for grants: an invariant the database is responsible for
-- belongs in the database, not in the caller that happens to be well-behaved.
--
-- S-06 inherits this for free. When the public form opens an `anon` insert
-- path, the writer is an unauthenticated stranger rather than the owner, and
-- this constraint is already in place to meet them.
--
-- Kept in step with src/lib/validation.ts SUBMISSION_CONTENT_MAX. The two must
-- change together; nothing enforces that pairing automatically, so the constant
-- carries a comment pointing here.
--
-- Forward-only: compensates the table definition in
-- 20260804171802_submission_intake.sql rather than editing it.

alter table public.submissions
  add constraint submissions_content_bounds
  check (
    char_length(content) <= 2000
    and char_length(btrim(content)) > 0
  );

comment on constraint submissions_content_bounds on public.submissions is
  'Mirrors SUBMISSION_CONTENT_MAX and the required-text rule in src/lib/validation.ts. Enforced here because Zod is not a boundary: a direct PostgREST call bypasses it.';
