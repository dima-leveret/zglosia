-- Correct the blank-content half of submissions_content_bounds.
--
-- 20260804183507_submission_content_bounds.sql wrote the emptiness rule as
-- `char_length(btrim(content)) > 0`. That is weaker than it looks: btrim/1
-- strips SPACES ONLY, so a submission consisting of tabs and newlines
-- (E'   \n\t  ') survives it and lands in the table as a blank row.
--
-- The constraint exists to mirror the Zod rule in src/lib/validation.ts, and
-- JavaScript's .trim() removes all whitespace — tabs, newlines, CR and form
-- feed included. So the two layers disagreed on what "blank" means, which is
-- precisely the drift the constraint was added to close.
--
-- Caught by the test added alongside the original migration: the whitespace-only
-- insert was expected to fail with 23514 and succeeded instead. That is the
-- test doing its job on its first run.
--
-- The regex is the direct statement of the rule: the value must contain at
-- least one character that is not whitespace. POSIX [:space:] covers space,
-- tab, newline, CR, form feed and vertical tab, so it matches .trim()'s notion
-- of whitespace rather than approximating it with a trim function.
--
-- Forward-only: drops and re-adds rather than editing the prior migration,
-- which is already applied remotely.

alter table public.submissions
  drop constraint submissions_content_bounds;

alter table public.submissions
  add constraint submissions_content_bounds
  check (
    char_length(content) <= 2000
    and content ~ '[^[:space:]]'
  );

comment on constraint submissions_content_bounds on public.submissions is
  'Mirrors SUBMISSION_CONTENT_MAX and the required-text rule in src/lib/validation.ts. Enforced here because Zod is not a boundary: a direct PostgREST call bypasses it. The regex matches .trim() semantics — btrim() would miss tab/newline-only content.';
