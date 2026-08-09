---
change_id: public-submission-form
title: Publiczny formularz zgłoszeń — klient wysyła bez logowania
status: implementing
created: 2026-08-09
updated: 2026-08-09
archived_at: null
---

## Notes

Źródło: `context/foundation/roadmap.md` — slice **S-06: Publiczny formularz zgłoszeń (klient)**.

- **Outcome:** Klient może wysłać zgłoszenie przez publiczny formularz bez logowania; zgłoszenie trafia trwale do wskazanej firmy i do żadnej innej.
- **PRD refs:** US-02, FR-006
- **Prerequisites:** S-05 (`public-form-url-qr`, done), S-02 (`submission-intake`, done)
- **Parallel with:** S-03, S-04
- **Unknowns:** Próg/akceptacja odporności na masowy spam (bez blokowania zwykłego klienta) — Owner: user. Block: no.
- **Risk:** Publiczny, bez logowania i bez tarcia dla klienta. Zgłoszenie musi być przypisane wyłącznie do firmy z linku (izolacja) i trwale zapisane (żadne nie ginie, NFR). Odporność na masowy spam bez blokowania pojedynczego klienta pozostaje otwartym pytaniem — nie blokuje MVP, ale kształtuje ten wycinek.
