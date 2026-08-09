---
change_id: public-form-url-qr
title: Publiczny adres formularza z nieprzewidywalnym identyfikatorem firmy + kod QR
status: implemented
created: 2026-08-09
updated: 2026-08-09
archived_at: null
---

## Notes

from @context/foundation/roadmap.md

Roadmap slice **S-05: Publiczny adres formularza + kod QR**
- **Outcome:** Właściciel może wygenerować publiczny adres formularza zgłoszeń z nieprzewidywalnym identyfikatorem firmy oraz odpowiadający mu kod QR.
- **PRD refs:** FR-004, FR-005, NFR (nieprzewidywalny adres — brak enumeracji)
- **Prerequisites:** F-01 (done) — dziedziczy wzorzec izolacji per-firma
- **Unlocks:** S-06 (public-submission-form)
- **Risk:** Nieprzewidywalny publiczny identyfikator to NFR bezpieczeństwa — sekwencyjne id przeciekłoby linki innych firm przez enumerację. QR kluczowy dla dystrybucji offline (naklejka, plakat). Wycinek owner-facing — nie wymaga jeszcze ścieżki klienta.
