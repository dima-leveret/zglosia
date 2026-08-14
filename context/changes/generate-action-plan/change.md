---
change_id: generate-action-plan
title: Generowanie i zapis planu działań ze zgłoszeń (north star)
status: implementing
created: 2026-08-14
updated: 2026-08-14
archived_at: null
---

## Notes

from @context/foundation/roadmap.md

Roadmap S-03 ⭐ north star:
- **Outcome:** Właściciel może na żądanie wygenerować podsumowanie najczęstszych problemów
  oraz plan działań ze zgłoszeń i zapisać go na koncie firmy.
- **PRD refs:** US-01, FR-011, FR-012
- **Prerequisites:** F-01 (owner-auth-tenant-isolation, done), S-02 (submission-intake, done)
- **Unknowns:** minimalna liczba zgłoszeń dla sensownego planu (próg vs brak progu);
  akceptowalny górny czas całej operacji generowania. Owner: user; nie blokują.
- **Risk:** halucynacje — plan musi być ugruntowany w realnych zgłoszeniach
  (odniesienia/cytaty, NFR). Widoczny feedback postępu (~2 s) jest częścią wycinka.
  Integracja LLM (OpenRouter, per `infrastructure.md`) żyje wewnątrz tego wycinka.
