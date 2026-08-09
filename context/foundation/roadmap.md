---
project: ZGŁOSIA
version: 1
status: draft
created: 2026-07-03
updated: 2026-07-03
prd_version: 1
main_goal: speed
top_blocker: time
---

# Roadmap: ZGŁOSIA

> Derived from `context/foundation/prd.md` (v1) + `tech-stack.md` + `infrastructure.md` + auto-researched codebase baseline.
> Edit-in-place; archive when superseded.
> Slices below are listed in dependency order. The "At a glance" table is the index.

## Vision recap

Właściciel małej firmy tonie w surowych zgłoszeniach klientów i nie potrafi wyciągnąć z nich
wniosku „co poprawić". ZGŁOSIA zbiera zgłoszenia (publiczny formularz + QR, plus ręczne wpisy)
i na żądanie przekłada je w zapisany **plan działań**. Rdzeń produktu (to, co odróżnia go od
zwykłego raportu — jeśli to usunąć, zostaje kolejne narzędzie do statystyk) to właśnie krok
od podsumowania do konkretnego, zapisywalnego planu.

## North star

**S-03: Właściciel generuje i zapisuje plan działań ze zgłoszeń** — to milestone walidacyjny:
najmniejszy pełny przepływ, którego udane dostarczenie dowodzi rdzennej hipotezy produktu,
umieszczony tak wcześnie, jak pozwalają na to zależności, bo cała reszta ma sens tylko jeśli
ten krok działa.

> „Gwiazda przewodnia" (north star) = najmniejszy pełny, użytkownikowi widoczny przepływ,
> który jeśli zadziała, udowadnia, że produkt spełnia swoją obietnicę. Tutaj: surowe
> zgłoszenia → wygenerowany i zapisany plan działań (FR-011, FR-012, US-01).

## At a glance

| ID    | Change ID                   | Outcome (Właściciel/Klient może …)                                    | Prerequisites | PRD refs                        | Status   |
| ----- | --------------------------- | --------------------------------------------------------------------- | ------------- | ------------------------------- | -------- |
| F-01  | owner-auth-tenant-isolation | (foundation) uwierzytelniony właściciel + izolowany tenant firmy       | —             | FR-001, Access Control, NFR-izolacja | done    |
| S-01  | company-profile             | wprowadzić, przejrzeć, edytować i usunąć dane firmy                    | F-01          | FR-002, FR-003                  | done |
| S-02  | submission-intake           | ręcznie dodać, przeglądać i usuwać zgłoszenia firmy                    | F-01          | FR-007, FR-008, FR-009          | done |
| S-03  | generate-action-plan        | wygenerować i zapisać plan działań ze zgłoszeń                         | F-01, S-02    | US-01, FR-011, FR-012           | proposed |
| S-04  | saved-plans-management      | przeglądać, edytować i usuwać zapisane plany                          | S-03          | FR-013, FR-014                  | proposed |
| S-05  | public-form-url-qr          | wygenerować nieprzewidywalny adres formularza i kod QR                 | F-01          | FR-004, FR-005, NFR-enumeracja  | proposed |
| S-06  | public-submission-form      | (klient) wysłać zgłoszenie przez publiczny formularz bez logowania    | S-05, S-02    | US-02, FR-006                   | proposed |

## Streams

Navigation aid — grupuje elementy dzielące łańcuch Prerequisites. Kanoniczna kolejność żyje
w grafie zależności poniżej; ta tabela to proponowana kolejność czytania między równoległymi ścieżkami.

| Stream | Theme                | Chain                                       | Note                                                                          |
| ------ | -------------------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| A      | Rdzeń wartości       | `F-01` → `S-02` → `S-03` → `S-04`           | Ścieżka must-have do gwiazdy przewodniej i zarządzania planami; priorytet przy celu `speed`. |
| B      | Profil firmy         | `S-01`                                       | Zależy od `F-01`, biegnie równolegle do Stream A; kontekst firmy opcjonalnie wzbogaca plan. |
| C      | Kanał publiczny      | `S-05` → `S-06`                              | `S-05` zależy od `F-01`; `S-06` dołącza do Stream A przy `S-02` (magazyn zgłoszeń).          |

## Baseline

Co jest już w kodzie na dzień `2026-07-03` (auto-research + potwierdzenie użytkownika).
Fundamenty poniżej zakładają, że to istnieje, i NIE budują tego od nowa.

- **Frontend:** present — Next.js 16.2.9 + React 19.2.4, App Router, Tailwind v4; `src/app/layout.tsx`, `page.tsx` (nadal domyślny szablon), `src/app/components/Header.tsx`.
- **Backend / API:** absent — brak `src/app/api/`, brak route handlers, brak server actions.
- **Data:** partial — SDK Supabase podłączone (`src/lib/supabase/client.ts`, `server.ts`), ale brak schematu, migracji, tabel i katalogu konfiguracji.
- **Auth:** partial — klienci Supabase (browser + admin) i klucze env obecne; brak przepływów logowania, middleware, tras magic-link (wybrany dostawca: Supabase magic link, per shape-notes/tech-stack).
- **Deploy / infra:** partial — Vercel jako zadeklarowany cel (`infrastructure.md`), auto-deploy-on-merge; brak commitowanego `.github/workflows` (natywna integracja Vercel — nie jest potrzebny dla MVP).
- **Observability:** absent — brak bibliotek logowania / śledzenia błędów; żadne NFR nie wymusza jej na tym etapie (cel `speed`).

## Foundations

### F-01: Uwierzytelnienie właściciela + baza izolacji per-firma

- **Outcome:** (foundation) właściciel loguje się przez magic link; istnieje pojedynczy, izolowany tenant firmy; polityka izolacji (RLS) udowodniona na rekordzie firmy i gotowa do ponownego użycia przez kolejne tabele.
- **Change ID:** owner-auth-tenant-isolation
- **PRD refs:** FR-001, Access Control (dwa rozłączne tryby dostępu), NFR (izolacja danych między firmami, RODO)
- **Unlocks:** S-01, S-02, S-05 oraz kontrakt izolacji dziedziczony przez S-03, S-04, S-06
- **Prerequisites:** — (baseline ma już podłączone SDK Supabase)
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Izolacja to load-bearing NFR (RODO); ustalenie wzorca RLS tutaj oznacza, że wszystkie kolejne zapytania go dziedziczą zamiast wymyślać na nowo. Minimalny zakres: tożsamość właściciela + rekord firmy + polityka izolacji — NIE cała warstwa danych; każdy wycinek dokłada własne tabele stosując ten wzorzec.
- **Status:** ready

## Slices

### S-01: Profil firmy

- **Outcome:** Właściciel może wprowadzić, przejrzeć, edytować i usunąć informacje o swojej firmie.
- **Change ID:** company-profile
- **PRD refs:** FR-002, FR-003
- **Prerequisites:** F-01
- **Parallel with:** S-02, S-05
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Niskie ryzyko, standardowy CRUD na izolowanym rekordzie firmy. Sekwencjonowane wcześnie, bo to naturalny krok po rejestracji, a kontekst firmy opcjonalnie wzbogaca plan (Business Logic); nie blokuje jednak gwiazdy przewodniej.
- **Status:** proposed

### S-02: Zgłoszenia — ręczne dodanie, lista, usuwanie

- **Outcome:** Właściciel może ręcznie dodać zgłoszenie (z oznaczeniem źródła), przeglądać listę zgłoszeń swojej firmy i usunąć zgłoszenie.
- **Change ID:** submission-intake
- **PRD refs:** FR-007, FR-008, FR-009
- **Prerequisites:** F-01
- **Parallel with:** S-01, S-05
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Ręczne dodawanie zasila gwiazdę przewodnią bez publicznego formularza — najszybsza droga do udowodnienia rdzenia przy celu `speed`. Model źródła (formularz vs ręczne, FR-008) i izolacja muszą być poprawne od początku, bo plan (S-03) na nich polega. Usuwanie pozwala oczyścić spam/duplikaty przed generowaniem.
- **Status:** proposed

### S-03: Generowanie i zapis planu działań  ⭐ north star

- **Outcome:** Właściciel może na żądanie wygenerować podsumowanie najczęstszych problemów oraz plan działań ze zgłoszeń i zapisać go na koncie firmy.
- **Change ID:** generate-action-plan
- **PRD refs:** US-01, FR-011, FR-012
- **Prerequisites:** F-01, S-02
- **Parallel with:** S-05
- **Blockers:** —
- **Unknowns:**
  - Minimalna liczba zgłoszeń dla sensownego planu (próg vs brak progu) — Owner: user. Block: no.
  - Akceptowalny górny czas całej operacji generowania — Owner: user. Block: no.
- **Risk:** Sedno produktu — tu spełnia się kryterium sukcesu. Główne zagrożenie to halucynacje: plan musi być wyraźnie ugruntowany w realnych zgłoszeniach (odniesienia/cytaty, NFR), a nie w zmyślonych treściach. Widoczny feedback postępu (NFR ~2 s) jest częścią wycinka. Integracja LLM (OpenRouter, per infrastructure.md) żyje wewnątrz tego wycinka, nie jako fundament.
- **Status:** proposed

### S-04: Zapisane plany — przegląd, edycja, usuwanie

- **Outcome:** Właściciel może przeglądać zapisane plany działań oraz je edytować i usuwać.
- **Change ID:** saved-plans-management
- **PRD refs:** FR-013, FR-014
- **Prerequisites:** S-03
- **Parallel with:** S-05
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Niskie ryzyko; zależy od istnienia zapisanych planów (S-03). Edycja pozwala dopracować i sprzątać plany; pożądane zachowanie oryginału generacji, by edycja nie zacierała, co dał model.
- **Status:** proposed

### S-05: Publiczny adres formularza + kod QR

- **Outcome:** Właściciel może wygenerować publiczny adres formularza zgłoszeń z nieprzewidywalnym identyfikatorem firmy oraz odpowiadający mu kod QR.
- **Change ID:** public-form-url-qr
- **PRD refs:** FR-004, FR-005, NFR (nieprzewidywalny adres — brak enumeracji)
- **Prerequisites:** F-01
- **Parallel with:** S-01, S-02, S-03, S-04
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Nieprzewidywalny publiczny identyfikator to NFR bezpieczeństwa: sekwencyjne id przeciekłoby linki innych firm przez enumerację. QR jest kluczowy dla offline'owej dystrybucji (naklejka, plakat). Owner-facing — nie wymaga jeszcze ścieżki klienta.
- **Status:** proposed

### S-06: Publiczny formularz zgłoszeń (klient)

- **Outcome:** Klient może wysłać zgłoszenie przez publiczny formularz bez logowania; zgłoszenie trafia trwale do wskazanej firmy i do żadnej innej.
- **Change ID:** public-submission-form
- **PRD refs:** US-02, FR-006
- **Prerequisites:** S-05, S-02
- **Parallel with:** S-03, S-04
- **Blockers:** —
- **Unknowns:**
  - Próg/akceptacja odporności na masowy spam (bez blokowania zwykłego klienta) — Owner: user. Block: no.
- **Risk:** Publiczny, bez logowania i bez tarcia dla klienta. Zgłoszenie musi być przypisane wyłącznie do firmy z linku (izolacja) i trwale zapisane (żadne nie ginie, NFR). Odporność na masowy spam bez blokowania pojedynczego klienta pozostaje otwartym pytaniem — nie blokuje MVP, ale kształtuje ten wycinek.
- **Status:** proposed

## Backlog Handoff

| Roadmap ID | Change ID                   | Suggested issue title                                  | Ready for `/10x-plan` | Notes |
| ---------- | --------------------------- | ------------------------------------------------------ | --------------------- | ----- |
| F-01       | owner-auth-tenant-isolation | Auth właściciela (magic link) + izolacja per-firma     | yes                   | Uruchom `/10x-plan owner-auth-tenant-isolation` — odblokowuje resztę |
| S-01       | company-profile             | Profil firmy — CRUD danych firmy                       | no                    | Czeka na F-01 |
| S-02       | submission-intake           | Zgłoszenia — ręczne dodanie, lista, usuwanie           | no                    | Czeka na F-01; ścieżka do north star |
| S-03       | generate-action-plan        | Generowanie i zapis planu działań (north star)         | no                    | Czeka na F-01, S-02 |
| S-04       | saved-plans-management      | Zapisane plany — przegląd, edycja, usuwanie            | no                    | Czeka na S-03 |
| S-05       | public-form-url-qr          | Publiczny adres formularza + kod QR                    | no                    | Czeka na F-01 |
| S-06       | public-submission-form      | Publiczny formularz zgłoszeń (klient, bez logowania)   | no                    | Czeka na S-05, S-02 |

## Open Roadmap Questions

1. **Minimalna liczba zgłoszeń dla sensownego planu** — czy generowanie wymaga progu, poniżej którego wynik byłby zbyt ogólnikowy? Owner: user. Block: S-03 (nie blokuje — MVP może startować bez progu).
2. **Akceptowalny górny czas generowania planu** — NFR daje widoczny feedback i próg ~2 s na brak wrażenia zawieszenia, ale brak twardego limitu całej operacji. Owner: user. Block: S-03 (nie blokuje).
3. **Próg/akceptacja odporności na masowy spam** — konkretny poziom odpierania masowych zgłoszeń bez blokowania zwykłego klienta. Owner: user (do rozstrzygnięcia na etapie doboru technologii). Block: S-06 (nie blokuje).

## Parked

- **FR-010: Edycja zgłoszenia** — Why parked: nice-to-have poza twardym MVP; edycja cudzego zgłoszenia fałszuje głos klienta. Jeśli kiedykolwiek — z zachowaniem oryginału.
- **Generowanie planu per pojedyncze zgłoszenie** — Why parked: PRD §Non-Goals; plan powstaje wyłącznie zbiorczo, na żądanie.
- **Wysyłka maili / powiadomień o nowym zgłoszeniu** — Why parked: PRD §Non-Goals; poza zakresem MVP.
- **Współdzielenie zgłoszeń między firmami** — Why parked: PRD §Non-Goals; twarda granica izolacji.
- **Import opinii z zewnętrznych platform (np. Google)** — Why parked: PRD §Non-Goals; brak zewnętrznych źródeł zgłoszeń w MVP.
- **Aplikacja mobilna** — Why parked: PRD §Non-Goals; na start wyłącznie web.
- **System płatności i subskrypcji** — Why parked: PRD §Non-Goals; brak warstwy billingowej na tym etapie.
- **Observability (logowanie / śledzenie błędów)** — Why parked: żadne NFR nie wymusza jej przy celu `speed`; wprowadzić dopiero, gdy pierwszy wycinek tego wymaga.

## Done

(Empty on first generation. `/10x-archive` appends entries here — and flips the item's `Status` to `done` — when a change whose `Change ID` matches a roadmap item is archived. Do NOT pre-populate.)
