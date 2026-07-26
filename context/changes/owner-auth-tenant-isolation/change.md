---
change_id: owner-auth-tenant-isolation
title: Owner auth (magic link) + per-company tenant isolation foundation
status: implementing
created: 2026-07-26
updated: 2026-07-26
archived_at: null
---

## Notes

Roadmap item F-01 (foundation). Outcome: uwierzytelniony właściciel (Supabase magic link) + izolowany tenant firmy; polityka izolacji (RLS) udowodniona na rekordzie firmy i gotowa do dziedziczenia przez kolejne tabele. PRD refs: FR-001, Access Control, NFR (izolacja danych, RODO). Unlocks S-01, S-02, S-05 oraz kontrakt izolacji dziedziczony przez S-03, S-04, S-06. Minimalny zakres: tożsamość właściciela + rekord firmy + polityka izolacji — NIE cała warstwa danych.
