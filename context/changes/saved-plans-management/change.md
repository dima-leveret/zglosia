---
change_id: saved-plans-management
title: Zapisane plany — przegląd, edycja i usuwanie
status: implementing
created: 2026-08-15
updated: 2026-08-15
archived_at: null
---

## Notes

from @context/foundation/roadmap.md

Roadmap S-04 (Stream A, rdzeń wartości):
- **Outcome:** Właściciel może przeglądać zapisane plany działań oraz je edytować i usuwać.
- **PRD refs:** FR-013, FR-014
- **Prerequisites:** S-03 (`generate-action-plan`, done) — Parallel with: S-05
- **Risk:** Niskie ryzyko; zależy od istnienia zapisanych planów. Edycja pozwala dopracować
  i sprzątać plany; pożądane zachowanie oryginału generacji, by edycja nie zacierała,
  co dał model.

## Acceptance (Phase 5, 2026-08-15)

Automated, all green:

- `npm run test:remote` — 9 files, 200 tests
- `npx supabase migration list --linked` — all 15 migrations carry a non-empty remote column,
  including this slice's `20260815160000`
- `npm run build` — compiled clean, TypeScript clean, 12 routes

Manual walkthrough, confirmed by the owner on a company with plans generated from real Polish
submissions: the index lists saved plans → open one → edit wording → remove a weak problem → save
in place → the original stays viewable → back to the index → delete a plan → gone from the index
and its URL 404s. Cross-tenant isolation checked by hand with a second account: a plan URL from
account A is a 404 for account B, indistinguishable from a nonexistent id. Deleting a plan left
submissions and the other plans untouched.

**FR-013 (przeglądać zapisane plany) and FR-014 (edytować i usuwać) are satisfied.**

Two Progress rows stay unticked on the record rather than being ticked by inference, both for the
same missing container runtime on this machine:

- **1.1** `supabase db reset` from empty — BLOCKED, as in `submission-intake` and
  `generate-action-plan`. Compensating control: the remote push (1.2) plus the Phase 2 contract
  suite.
- **2.5** removing the renumber's offset pass to watch the contiguity test fail with `23505` —
  WAIVED by the owner. Beyond the missing runtime, the experiment is non-deterministic: without the
  offset, whether the set-based `UPDATE` collides depends on row scan order. Compensating control:
  the renumbering tests assert exact contiguity *and* the surviving titles/contents in order, so a
  half-applied renumber fails on values rather than on an error code.
