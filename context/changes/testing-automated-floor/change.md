---
change_id: testing-automated-floor
title: Rollout Phase 1 — automated test floor and migration-state gate
status: preparing
created: 2026-08-17
updated: 2026-08-23
archived_at: null
---

## Notes

Rollout Phase 1 of `context/foundation/test-plan.md`: "Automated floor + migration-state gate".

Goal: make the suite that already exists run on every change, and make an unapplied migration fail loudly instead of silently.

Risks covered:

- Risk #1 — A change believed shipped is live only in the repo: the deployed app runs against a schema that is behind, so a privilege the migration was written to close is still open in production.
- Risk #2 — A new table or column ships with a wrong grant: too narrow, so every owner read fails on a database built from empty; or too broad, so an owner rewrites a column they must not, including the company identifier FR-004 requires unpredictable.

Test types planned: gates, migration-state verification. This phase deliberately adds no new test code — the existing ~200 tests across 9 files already assert the grant/policy denials; what is missing is a loop that fires them.

Risk response intent:

- Risk #1: prove that merging a schema change without applying it fails visibly before the code depending on it is serving traffic. The gate must assert remote database state, not files in the repo.
- Risk #2: prove that a verb the code never exercises, and a column the owner must not rewrite, are both rejected on a database built from empty — a from-empty rebuild is the point, since a long-lived database hides missing grants.
