---
change_id: company-profile
title: Company profile — owner CRUD for company data
status: implementing
created: 2026-07-29
updated: 2026-07-29
archived_at: null
---

## Notes

Roadmap item S-01 (slice), source: `context/foundation/roadmap.md`. Outcome: właściciel może wprowadzić, przejrzeć, edytować i usunąć informacje o swojej firmie. PRD refs: FR-002, FR-003. Prerequisites: F-01 (`owner-auth-tenant-isolation`, status: implemented) — ten wycinek dziedziczy wzorzec izolacji RLS udowodniony na rekordzie firmy zamiast wymyślać go na nowo. Parallel with: S-02, S-05. Risk: niskie — standardowy CRUD na izolowanym rekordzie firmy; nie blokuje gwiazdy przewodniej (S-03), ale kontekst firmy opcjonalnie wzbogaca plan (Business Logic).
