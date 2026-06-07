---
project: "ZGŁOSIA"
context_type: greenfield
created: 2026-06-07
updated: 2026-06-07
product_type: web-app
target_scale:
  users: medium
  qps: low
  data_volume: small
timeline_budget:
  mvp_weeks: 3
  hard_deadline: 2026-09-14
  after_hours_only: true
checkpoint:
  current_phase: 8
  phases_completed: [1, 2, 3, 4, 5, 6, 7]
  gray_areas_resolved:
    - topic: "primary persona"
      decision: "Właściciel małej firmy — solo, brak działu CX"
    - topic: "pain category"
      decision: "Czasochłonność + paraliż decyzyjny"
    - topic: "insight"
      decision: "Wartość w planie działań, nie w raporcie/statystykach"
    - topic: "auth model"
      decision: "Właściciel: passwordless magic link, płaski model (1 konto = 1 firma); klient: anonimowy formularz"
  frs_drafted: 14
  quality_check_status: accepted
---

# Shape Notes — ZGŁOSIA

Seed idea (verbatim from `idea-notes.md`):
> Analiza zgłoszeń od klienta jest czasochłonna, co powoduje znaczne przedłużenie
> reakcji i działań firmy. ZGŁOSIA pozwala firmie zbierać zgłoszenia klientów
> (formularz pod unikalnym URL + QR), a AI na żądanie podsumowuje najczęstsze
> problemy i generuje plan działań usprawniających.

<!-- Sections below are filled phase by phase per the PRD schema. -->

## Vision & Problem Statement

Właściciel małej firmy zbiera zgłoszenia od klientów (uwagi, skargi, sugestie), ale
ręczne ich przeglądanie jest czasochłonne i prowadzi do paraliżu decyzyjnego: widzi
napływające zgłoszenia, lecz trudno mu wyciągnąć z nich konkretny wniosek "co właściwie
poprawić". Efekt to opóźniona reakcja i działania firmy.

Insight: status quo (arkusze, intuicja, ewentualnie raporty) zatrzymuje się na
statystykach. Realna wartość leży w gotowym **planie działań** — output, który mówi
właścicielowi CO zrobić, a nie tylko ile czego wpłynęło. To właśnie ten krok od
podsumowania do planu jest sednem produktu.

## User & Persona

Primary persona: **Właściciel małej firmy.** Sam odpowiada za zbieranie zgłoszeń,
ich analizę i decyzje usprawniające — nie ma osobnego działu obsługi klienta ani
analityka. Sięga po produkt w momencie, gdy zgłoszeń uzbierało się na tyle, że ręczne
przejrzenie i wyciągnięcie wniosków staje się barierą.

### Secondary actor
Klient firmy — anonimowy autor zgłoszenia. Nie jest użytkownikiem aplikacji w sensie
konta; styka się z produktem tylko przez publiczny formularz zgłoszeniowy.

## Access Control

Dwa rozłączne tryby dostępu:

- **Właściciel (uwierzytelniony).** Logowanie passwordless — magic link wysyłany na
  email (mechanizm jako preferencja użytkownika; ostateczna implementacja to decyzja
  downstream). Płaski model: jedno konto = jedna firma, jeden właściciel. Brak ról,
  brak zapraszania zespołu w MVP. Właściciel widzi i zarządza wyłącznie danymi własnej
  firmy: informacjami o firmie, zgłoszeniami oraz wygenerowanymi planami działań.
- **Klient (anonimowy).** Brak konta i logowania. Dostęp wyłącznie do publicznego
  formularza zgłoszeniowego pod URL-em zawierającym ID firmy (lub przez kod QR).
  Może jedynie wysłać zgłoszenie do wskazanej firmy; nie ma wglądu w żadne dane.

Nieuwierzytelniony użytkownik próbujący wejść na trasę właściciela jest kierowany do
logowania.

## Success Criteria

### Primary
- Właściciel przechodzi pełny przepływ: rejestracja → wprowadzenie danych firmy →
  wygenerowanie URL formularza + kodu QR → zebranie zgłoszeń (przez formularz lub
  dodane ręcznie) → wygenerowanie na żądanie podsumowania najczęstszych problemów
  oraz **planu działań** → zapis planu na koncie. Produkt zadziałał, gdy z surowych
  zgłoszeń powstaje zapisany, sensowny plan działań.

### Secondary
- Wygenerowany plan da się edytować / uzupełnić notatkami przed zapisaniem (miłe,
  ale nie wystarcza samo w sobie do uznania MVP za udane).

### Guardrails
- Izolacja danych między firmami — firma nigdy nie widzi zgłoszeń ani planów innej firmy.
- Publiczny formularz działa bez logowania — klient zawsze może złożyć zgłoszenie z linku/QR.
- Żadne wysłane zgłoszenie nie ginie — trwale zapisane i dostępne do analizy.
- Generowanie planu daje widoczny feedback i kończy się w akceptowalnym dla użytkownika czasie.

## Functional Requirements

### Konto & uwierzytelnianie
- FR-001: Właściciel can zarejestrować się i zalogować przez magic link. Priority: must-have
  > Socrates: Kontrargument rozważony (auth zbędny dla solo / zawodność maili). Rozwiązanie: zostaje — logowanie jest niezbędne dla izolacji danych firmy.

### Profil firmy
- FR-002: Właściciel can wprowadzić i zapisać informacje o firmie. Priority: must-have
  > Socrates: Kontrargument rozważony (dane firmy mogą być zbędne dla analizy). Rozwiązanie: zostaje — kontekst firmy poprawia trafność planu.
- FR-003: Właściciel can przeglądać, edytować i usuwać informacje o firmie. Priority: must-have
  > Socrates: Kontrargument rozważony (pełny CRUD to przerost). Rozwiązanie: zostaje bez zmian.

### Formularz & dystrybucja
- FR-004: Właściciel can wygenerować URL formularza zgłoszeń zawierający nieprzewidywalny identyfikator firmy. Priority: must-have
  > Socrates: Kontrargument przyjęty: sekwencyjne ID umożliwia enumerację linków innych firm. Rozwiązanie: identyfikator firmy w publicznym URL musi być nieprzewidywalny (nie sekwencyjny) — patrz NFR; mechanizm to decyzja downstream.
- FR-005: Właściciel can wygenerować kod QR na podstawie URL formularza. Priority: must-have
  > Socrates: Kontrargument rozważony (QR zbędny w MVP). Rozwiązanie: zostaje must-have — kluczowy dla offline'owej dystrybucji (naklejka, plakat, stolik).
- FR-006: Klient can wysłać zgłoszenie przez publiczny formularz bez logowania. Priority: must-have
  > Socrates: Kontrargument rozważony (anonimowość = ryzyko spamu). Rozwiązanie: zostaje — brak tarcia ważniejszy; ryzyko spamu adresowane jako NFR/Open Question.

### Zgłoszenia
- FR-007: Właściciel can przeglądać zgłoszenia swojej firmy. Priority: must-have
  > Socrates: Kontrargument rozważony (surowa lista przytłacza). Rozwiązanie: zostaje — to AI robi syntezę, nie ręczne czytanie.
- FR-008: Właściciel can ręcznie dodać zgłoszenie. Priority: must-have
  > Socrates: Kontrargument przyjęty: ręczne wpisy zacierają granicę "głos klienta" vs "wpis właściciela". Rozwiązanie: zachowane, ale zgłoszenie powinno nieść oznaczenie źródła (formularz vs ręczne).
- FR-009: Właściciel can usunąć zgłoszenie. Priority: must-have
  > Socrates: Kontrargument rozważony (usuwanie psuje historię analiz). Rozwiązanie: zostaje — właściciel musi móc usunąć spam/duplikaty, by nie fałszowały planu.
- FR-010: Właściciel can edytować zgłoszenie. Priority: nice-to-have
  > Socrates: Kontrargument przyjęty: edycja cudzego zgłoszenia fałszuje głos klienta i dane wejściowe analizy. Rozwiązanie: pozostaje poza twardym MVP (nice-to-have); jeśli kiedykolwiek, to z zachowaniem oryginału.

### Analiza AI & plany
- FR-011: Właściciel can na żądanie wygenerować podsumowanie najczęstszych problemów oraz plan działań na podstawie zgłoszeń. Priority: must-have
  > Socrates: Kontrargument przyjęty: AI może halucynować — plan oparty na zmyślonych problemach jest gorszy niż brak planu. Rozwiązanie: zostaje (to serce produktu), ale plan musi być wyraźnie oparty na realnych zgłoszeniach (odniesienia/cytaty) — patrz NFR.
- FR-012: Właściciel can zapisać wygenerowany plan działań na koncie firmy. Priority: must-have
  > Socrates: Kontrargument rozważony (plan jako jednorazowy output). Rozwiązanie: zostaje — zapis pozwala wracać i porównywać plany w czasie.
- FR-013: Właściciel can przeglądać zapisane plany działań. Priority: must-have
  > Socrates: Kontrargument rozważony (jeden najnowszy plan wystarczy). Rozwiązanie: zostaje — naturalne następstwo zapisywania planów.
- FR-014: Właściciel can edytować i usuwać zapisane plany działań. Priority: must-have
  > Socrates: Kontrargument rozważony (edycja zaciera, co dał AI). Rozwiązanie: zostaje — właściciel musi dopracować i sprzątać plany.

## Business Logic

Z zbioru zgłoszeń klientów aplikacja wyłania powtarzające się problemy, priorytetyzuje
je według częstości i pilności, a następnie przekłada na konkretny plan działań
usprawniających pracę firmy.

Wejściem są surowe zgłoszenia zebrane dla danej firmy (z publicznego formularza oraz
dodane ręcznie przez właściciela), opcjonalnie wzbogacone o kontekst informacji o firmie.
Wyjściem jest dwuczęściowy artefakt: (1) podsumowanie najczęściej powtarzających się
problemów uszeregowanych według wagi oraz (2) plan działań — uporządkowana lista
konkretnych kroków usprawniających, powiązanych z wyłonionymi problemami. Właściciel
napotyka regułę w jednym momencie: gdy świadomie uruchamia generowanie na zebranych
zgłoszeniach i otrzymuje gotowy, zapisywalny plan, którego sam by ręcznie nie złożył.

## Non-Functional Requirements

- Wygenerowany plan działań jest wyraźnie ugruntowany w faktycznych zgłoszeniach firmy —
  każdy wyłoniony problem da się powiązać z realnymi zgłoszeniami, a nie ze zmyślonymi
  treściami (ograniczenie halucynacji).
- Publicznego adresu formularza zgłoszeniowego nie da się zgadnąć ani uzyskać przez
  enumerację identyfikatorów innych firm.
- Podczas generowania planu użytkownik widzi ciągły, widoczny postęp; żadna operacja
  trwająca dłużej niż ~2 s nie wygląda na zawieszoną.
- Zgłoszenia i plany jednej firmy są nieosiągalne dla jakiejkolwiek innej firmy; dane
  klientów przetwarzane są zgodnie z RODO.
- Publiczny formularz odpiera masowe, automatyczne zgłoszenia (nadużycia/spam), nie
  blokując przy tym zwykłego klienta składającego pojedyncze zgłoszenie.
- Żadne wysłane zgłoszenie nie ginie — po potwierdzeniu wysyłki jest trwale zapisane.

## Non-Goals

Funkcjonalne:
- Generowanie planu na każde pojedyncze zgłoszenie — plan powstaje wyłącznie zbiorczo,
  na żądanie, z wielu zgłoszeń. Per-zgłoszenie to zupełnie inny tryb pracy.
- Wysyłka maili / powiadomień do firmy o nowym zgłoszeniu — poza zakresem MVP.
- Współdzielenie zgłoszeń między firmami — twarda granica izolacji, brak puli wspólnej.
- Integracja z opiniami Google — brak zewnętrznych źródeł zgłoszeń w MVP.
- Aplikacja mobilna — na początek wyłącznie web.

Niefunkcjonalne / biznesowe:
- System opłat i subskrypcji (np. Stripe, plany taryfowe) — produkt na tym etapie
  nie pobiera płatności; brak warstwy billingowej.

## Quality cross-check

Status: **accepted** — wszystkie wymagane elementy obecne, brak luk:

- Access Control: present (właściciel uwierzytelniony + klient anonimowy; izolacja firm).
- Business Logic: present (jednozdaniowa reguła: wyłanianie + priorytetyzacja problemów → plan działań).
- Project artifacts: present (shape-notes.md z poprawnym checkpointem).
- Timeline-cost ack: present (mvp_weeks = 3, ≤ 3; twardy deadline 2026-09-14, praca po godzinach).
- Non-Goals: present (5 funkcjonalnych + 1 biznesowy).

Brak gapów do przeniesienia do `## Open Questions` z tytułu cross-checku.

## User Stories

### US-01: Właściciel generuje plan działań ze zgłoszeń

- **Given** zalogowany właściciel z co najmniej jednym zapisanym zgłoszeniem
- **When** wybiera akcję "Wygeneruj plan działań"
- **Then** otrzymuje podsumowanie najczęściej powtarzających się problemów oraz plan
  działań usprawniających, który może zapisać na koncie firmy

#### Acceptance Criteria
- Przy braku zgłoszeń akcja jest niedostępna lub pokazuje stan pusty z wyjaśnieniem,
  a nie pusty/błędny plan.
- Podsumowanie odnosi się wyłącznie do zgłoszeń tej firmy (izolacja danych).
- Wygenerowany plan można zapisać i odnaleźć później na koncie.
- W trakcie generowania użytkownik widzi feedback o postępie.

### US-02: Klient wysyła zgłoszenie przez formularz

- **Given** klient, który otworzył publiczny URL formularza (z ID firmy) lub zeskanował QR
- **When** wypełnia i wysyła zgłoszenie
- **Then** zgłoszenie trafia trwale do właściwej firmy i staje się dostępne do analizy

#### Acceptance Criteria
- Wysłanie nie wymaga logowania ani konta.
- Zgłoszenie jest przypisane do firmy wskazanej w linku i do żadnej innej.
- Po wysłaniu klient dostaje potwierdzenie; zgłoszenie nie ginie.
