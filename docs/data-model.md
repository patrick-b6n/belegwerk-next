# Data model

SQLite, described as a Drizzle schema in
[`src/persistence/schema.ts`](../src/persistence/schema.ts). The schema is the
source of truth; `drizzle-kit` generates the SQL migrations from it.

## Tables

| Table        | Columns                                                                                                                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bookings`   | `id`, `date`, `type`, `gross_cents`, `vat_rate`, `net_cents`, `vat_cents`, `category_id` → `categories`, `description`, `counterparty`, `reference`, `note`, `source`, `external_id`, `created_at`, `updated_at` |
| `categories` | `id`, `name`, `type`, `euer_position`, `reduces_income`, `archived`, `is_system`                                                                                                                                 |
| `tax_years`  | `year` (PK), `small_business`                                                                                                                                                                                    |
| `settings`   | `key` (PK), `value` – Stripe (#28): `stripe.apiKey`, `stripe.defaultVatRate`, `stripe.feeCategoryId`, `stripe.refundCategoryId`, import (#30): `stripe.lastImportAt`, `stripe.lastImportTo`                      |

Indexes: `bookings_date_idx` (`date`), `bookings_category_id_idx`
(`category_id`), `bookings_source_external_id_unique` (unique on
`source, external_id` **where `external_id IS NOT NULL`**),
`categories_type_name_unique` (`type, name`).

## Decisions

| Topic             | Decision                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IDs               | `INTEGER PRIMARY KEY AUTOINCREMENT`. Simple, sortable, small. UUIDs add nothing: there is no distributed generation, and `external_id` detects Stripe duplicates. `AUTOINCREMENT` prevents IDs of deleted rows from being reused.                                                                                                                                             |
| Date              | `TEXT` as an ISO calendar date `YYYY-MM-DD` (as `formatDate` expects), without time/time zone. Sorts correctly lexicographically; the EÜR year is `substr(date, 1, 4)` or a range comparison. CHECK `date(date) IS date` rejects format errors and non-existent days (`2025-02-30`).                                                                                          |
| Timestamps        | `created_at`/`updated_at` as `TEXT` in the format of `Date#toISOString()` (UTC, `2025-03-07T12:34:56.789Z`). No DB default: the repositories (#11) set both values so tests can use a fixed clock.                                                                                                                                                                            |
| Amounts           | `INTEGER` in cents. `gross_cents > 0` (amounts always positive, #1), `net_cents`/`vat_cents >= 0` and `net_cents + vat_cents = gross_cents`; all three with CHECK `typeof(x) = 'integer'`. Business computes net/VAT; the DB only guarantees consistency.                                                                                                                     |
| VAT rate          | `TEXT`: `'0'`, `'7'`, `'19'`, `'reverse_charge'` or `NULL` (no rate recorded, small business). Text instead of a number so reverse charge is not a special value and `0 %` stays clearly distinct from "no rate". VAT (`vat_cents > 0`) only exists for `'7'` and `'19'`; the CHECK uses `coalesce(vat_rate, '')` because `NULL IN (…)` yields NULL and would pass the CHECK. |
| Enums             | `TEXT` with CHECK (`type`: `income`/`expense`, `source`: `manual`/`stripe`). The allowed values are constants in the schema; business has its own domain types (#11), the repositories map between them.                                                                                                                                                                      |
| Booleans          | `INTEGER` 0/1 (Drizzle `mode: "boolean"`), `NOT NULL DEFAULT false`, CHECK `IN (0, 1)`.                                                                                                                                                                                                                                                                                       |
| Required fields   | `description` and `counterparty` are `NOT NULL`; `reference`, `note`, `external_id`, `vat_rate` optional. Business prevents empty strings, not the DB – exception `external_id`: `''` is forbidden by CHECK because it would collide like a real ID in the unique index.                                                                                                      |
| Category          | `category_id` `NOT NULL`, foreign key with `ON DELETE RESTRICT`: categories with bookings are archived instead of deleted. Business checks that the booking type matches the category type.                                                                                                                                                                                   |
| Category names    | Unique per type (`type, name`), case-sensitive in the DB (SQLite `NOCASE` does not know umlauts). Business (#14/#15) normalises names (trim) and compares case-insensitively before saving (`toLocaleLowerCase("de")`, including umlauts). "Reduces income" only for expense categories (CHECK), since refunds are expenses (#1).                                             |
| EÜR position      | `euer_position` is a stable key (`TEXT`, e.g. `BETRIEBSEINNAHMEN_UST_PFLICHTIG`) without CHECK – the list of positions lives in code ([EÜR positions](#eür-positions-13)) and may grow without needing a migration. Business validates the value (`validateCategoryPosition`).                                                                                                |
| Tax years         | `year` (`INTEGER`, 1000–9999) is the primary key.                                                                                                                                                                                                                                                                                                                             |
| Duplicate guard   | Partial unique index on `(source, external_id) WHERE external_id IS NOT NULL`: manual bookings without an external ID never collide; deleted Stripe bookings can be imported again.                                                                                                                                                                                           |
| Columns in CHECKs | Unqualified in the schema via `col(...)` (`"date"` instead of `"bookings"."date"`). When drizzle-kit rebuilds a table as `__new_<table>` in a later migration, it copies the constraint text; a reference to `"bookings"` would fail there.                                                                                                                                   |

drizzle-kit does not support `STRICT` tables; without the `typeof` CHECKs
SQLite would store e.g. `1.5` in an `INTEGER` column. Text like `'100'` is
converted to the number `100` by the column's type affinity before the CHECK
runs; it is therefore accepted as whole cents (see test).

## EÜR positions (#13)

Code in [`src/business/euer`](../src/business/euer) (pure, no DB – except for
the services, which load and save via unit of work or `FileSaver`):

| File                     | Contents                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `positions.ts`           | `EUER_POSITIONS` (stable keys), `EUER_POSITION_DEFINITIONS` (side, assignable, small business target), `positionForTaxStatus` |
| `line-mapping.ts`        | `EUER_LINE_MAPPINGS` (year → position → line + official label), `describePosition(position, year)`, `hasLineMapping(year)`    |
| `category-position.ts`   | `validateCategoryPosition({ type, euerPosition, reducesIncome })` for the category service (#15)                              |
| `calculate-euer.ts`      | `calculateEuer({ year, smallBusiness, groups, categories })` – the EÜR calculation (#25), pure                                |
| `euer-service.ts`        | `createEuerService({ unitOfWork })` with `calculate(year)`: status, categories and sums in one unit of work                   |
| `report-order.ts`        | `incomeInReportOrder(result)`: income lines in form order, line 13 after line 12 (view #26, export #27)                       |
| `euer-csv.ts`            | `euerToCsv(result, labels)` – CSV of the EÜR (#27, see docs/architecture.md)                                                  |
| `euer-export-service.ts` | `createEuerExportService({ euer, fileSaver })` with `exportCsv(…)`: calculate, save dialog, write                             |

- **Stable keys.** Categories store only the key. Keys are never renamed or
  removed (they are in the DB); new positions are simply new keys.
- **Lines per year.** `describePosition("TELEKOMMUNIKATION", 2025)` returns
  `{ position, line: 43, label: "Aufwendungen für Telekommunikation (z. B. Telefon, Internet)" }`.
  If the mapping for the year or the position is missing, only `{ position }`
  is returned; the UI then shows the position's display name.
- **Source 2025:** official form Anlage EÜR 2025 (2025AnlEÜR801–803,
  "August 2025") and "Anleitung zur Anlage EÜR – August 2025 – Version
  1.9.1.1", published with the BMF letter of 29.08.2025, GZ IV C 6 -
  S 2142/00023/010/001 (BStBl I 2025 S. 1652):
  <https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2025-08-29-anlage-EUER-2025.pdf?__blob=publicationFile&v=3>.
  All lines in the mapping are checked against the form.
- **Source 2026:** official form Anlage EÜR 2026 (2026AnlEÜR801–803,
  "August 2026") and "Anleitung zur Anlage EÜR – August 2026 – Version
  2.5.1.1", published with the BMF letter of 01.09.2026, GZ IV C 6 -
  S 2142/00024/010/001:
  <https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2026-09-01-anlage-EUER-2026.pdf?__blob=publicationFile&v=2>.
  All lines checked. Compared to 2025, line 27 ("Bildung Rücklage
  Tierbewertung bei Land- und Forstwirten") is new: income lines 12–18 stay,
  `WAREN` moves from 27 to 29, all other expense lines from Fremdleistungen
  on move down by one. The labels are the same in both years
  (`LABELS_2025_2026`).
- **Labels** are form data (like line numbers), not UI texts: they live in
  code instead of Paraglide. Pure filling instructions in the form
  (references to other lines, 10-day rule) are omitted; parentheses that
  describe the content (examples, "auch zurückgezahlte Hilfen/Zuschüsse
  aufgrund der Corona-Pandemie") stay. The **display names** of the
  positions (e.g. in the category form, without a year) are UI texts:
  `euer_position_<key>` in `messages/de.json`, mapped in
  `src/ui/euer/position-name.ts` (`euerPositionName`).

### Positions and lines 2025/2026

| Position                                             | Side    | Line 2025 | Line 2026 | Note                                                                  |
| ---------------------------------------------------- | ------- | --------- | --------- | --------------------------------------------------------------------- |
| `BETRIEBSEINNAHMEN_KLEINUNTERNEHMER`                 | Income  | 12        | 12        | computed only, not assignable (see below)                             |
| `BETRIEBSEINNAHMEN_KLEINUNTERNEHMER_NICHT_STEUERBAR` | Income  | 13        | 13        | "of which" line, informational only (`informational`), not assignable |
| `BETRIEBSEINNAHMEN_UST_PFLICHTIG`                    | Income  | 15        | 15        | net                                                                   |
| `BETRIEBSEINNAHMEN_UST_FREI`                         | Income  | 16        | 16        | tax-exempt, not taxable, 0 %, reverse charge (§ 13b UStG)             |
| `UST_VEREINNAHMT`                                    | Income  | 17        | 17        | computed from the VAT share of income, not assignable                 |
| `UST_ERSTATTUNG`                                     | Income  | 18        | 18        | category "USt-Erstattung"                                             |
| `WAREN`                                              | Expense | 27        | 29        |                                                                       |
| `FREMDLEISTUNGEN`                                    | Expense | 29        | 30        |                                                                       |
| `GWG`                                                | Expense | 36        | 37        |                                                                       |
| `MIETE_GESCHAEFTSRAEUME`                             | Expense | 39        | 40        |                                                                       |
| `TELEKOMMUNIKATION`                                  | Expense | 43        | 44        |                                                                       |
| `REISENEBENKOSTEN`                                   | Expense | 44        | 45        | accommodation, incidental travel costs                                |
| `FORTBILDUNG`                                        | Expense | 45        | 46        |                                                                       |
| `RECHTS_STEUERBERATUNG`                              | Expense | 46        | 47        |                                                                       |
| `MIETE_LEASING_BEWEGLICH`                            | Expense | 47        | 48        |                                                                       |
| `BEITRAEGE_VERSICHERUNGEN`                           | Expense | 49        | 50        |                                                                       |
| `EDV_KOSTEN`                                         | Expense | 50        | 51        |                                                                       |
| `ARBEITSMITTEL`                                      | Expense | 51        | 52        | office supplies, postage, specialist literature                       |
| `WERBUNG`                                            | Expense | 54        | 55        |                                                                       |
| `VORSTEUER`                                          | Expense | 57        | 58        | computed from the VAT share of expenses, not assignable               |
| `UST_AN_FA`                                          | Expense | 58        | 59        | category "USt-Vorauszahlung"                                          |
| `SONSTIGE_AUSGABEN`                                  | Expense | 60        | 61        | other fully deductible business expenses                              |
| `BEWIRTUNG`                                          | Expense | 63        | 64        | columns "not deductible"/"deductible" (see below)                     |
| `VERPFLEGUNGSMEHRAUFWAND`                            | Expense | 64        | 65        |                                                                       |
| `FAHRTKOSTEN`                                        | Expense | 70        | 71        | other actual travel costs (e.g. train, flight, public transport)      |
| `FAHRTKOSTEN_PRIVATFAHRZEUG`                         | Expense | 71        | 72        | vehicle not in business assets (Nutzungseinlage)                      |

### Small business (Kleinunternehmer)

According to the 2025 instructions (line 12), small businesses enter their
full business income excluding the amounts of lines 18–22 in line 12; they
usually do not use lines 15–17. Categories therefore keep their position
(`BETRIEBSEINNAHMEN_UST_PFLICHTIG`/`_UST_FREI`), and the EÜR calculation
(#25) maps them to `BETRIEBSEINNAHMEN_KLEINUNTERNEHMER` in a small business
year with `positionForTaxStatus(position, smallBusiness)`. Changing a year's
tax status thus needs no change to categories. `UST_ERSTATTUNG` and all
expenses stay unchanged. `BETRIEBSEINNAHMEN_KLEINUNTERNEHMER`,
`BETRIEBSEINNAHMEN_KLEINUNTERNEHMER_NICHT_STEUERBAR`, `UST_VEREINNAHMT` and
`VORSTEUER` are **not assignable** – they only arise in the calculation.

Line 13 ("davon nicht steuerbare Umsätze sowie Umsätze nach § 19 Abs. 2 …")
is an informational "of which" line: its amount is already included in line
12 and does not count towards total business income (`informational: true`).

If a small business owes VAT as the recipient of a service under § 13b UStG
(e.g. for ads or payment fees from foreign providers), it pays it to the tax
office: these payments belong to `UST_AN_FA` (category "USt-Vorauszahlung");
there is no input tax deduction.

### Income reduction (`reduces_income`)

An income reduction category is an **expense** category whose
`euer_position` is the **income** position it reduces (default:
"Erlösminderung / Rückerstattung" → `BETRIEBSEINNAHMEN_UST_PFLICHTIG`).
`validateCategoryPosition` returns these error codes:

| Case                                  | Allowed position                                                                 | Error code otherwise                       |
| ------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------ |
| every category                        | known and assignable                                                             | `unknownPosition`, `positionNotAssignable` |
| income category                       | income position                                                                  | `positionKindMismatch`                     |
| expense category                      | expense position                                                                 | `positionKindMismatch`                     |
| expense category with `reducesIncome` | income position                                                                  | `reducesIncomeNeedsIncomePosition`         |
| expense category with `reducesIncome` | turnover position (15/16, with small business target), not e.g. `UST_ERSTATTUNG` | `reducesIncomeNeedsTurnoverPosition`       |
| income category with `reducesIncome`  | –                                                                                | `reducesIncomeNotExpense` (DB: CHECK)      |

The EÜR calculation (#25) subtracts the amounts of such bookings from their
position instead of counting them as an expense (in a small business year
after `positionForTaxStatus`, i.e. from line 12); the VAT share of a refund
in a regularly taxed year reduces `UST_VEREINNAHMT` (correction of the VAT
owed), not `VORSTEUER` – see [EÜR calculation](#eür-calculation-25).

### Default categories (migration `0001_default_categories`)

| Type    | Name                                               | Position                          | System |
| ------- | -------------------------------------------------- | --------------------------------- | ------ |
| Income  | Umsatzerlöse                                       | `BETRIEBSEINNAHMEN_UST_PFLICHTIG` |        |
| Income  | Steuerfreie / nicht steuerbare Erlöse              | `BETRIEBSEINNAHMEN_UST_FREI`      |        |
| Income  | USt-Erstattung                                     | `UST_ERSTATTUNG`                  | yes    |
| Expense | Fremdleistungen                                    | `FREMDLEISTUNGEN`                 |        |
| Expense | Geringwertige Wirtschaftsgüter (GWG)               | `GWG`                             |        |
| Expense | Miete Geschäftsräume                               | `MIETE_GESCHAEFTSRAEUME`          |        |
| Expense | Telefon / Internet                                 | `TELEKOMMUNIKATION`               |        |
| Expense | Übernachtung / Reisenebenkosten                    | `REISENEBENKOSTEN`                |        |
| Expense | Verpflegungsmehraufwand                            | `VERPFLEGUNGSMEHRAUFWAND`         |        |
| Expense | Fahrtkosten                                        | `FAHRTKOSTEN`                     |        |
| Expense | Fortbildung                                        | `FORTBILDUNG`                     |        |
| Expense | Rechts- und Steuerberatung, Buchführung            | `RECHTS_STEUERBERATUNG`           |        |
| Expense | Beiträge / Versicherungen                          | `BEITRAEGE_VERSICHERUNGEN`        |        |
| Expense | EDV-Kosten / Software                              | `EDV_KOSTEN`                      |        |
| Expense | Bürobedarf / Porto / Fachliteratur                 | `ARBEITSMITTEL`                   |        |
| Expense | Werbung                                            | `WERBUNG`                         |        |
| Expense | Bewirtung                                          | `BEWIRTUNG`                       |        |
| Expense | Bank- und Zahlungsgebühren                         | `SONSTIGE_AUSGABEN`               |        |
| Expense | Sonstige Betriebsausgaben                          | `SONSTIGE_AUSGABEN`               |        |
| Expense | USt-Vorauszahlung                                  | `UST_AN_FA`                       | yes    |
| Expense | Erlösminderung / Rückerstattung (`reduces_income`) | `BETRIEBSEINNAHMEN_UST_PFLICHTIG` | yes    |

- `is_system = 1` only for the categories the EÜR relies on (VAT to/from the
  tax office, income reduction). The category service (#15) only allows
  renaming them: no archiving, no deleting, position and "reduces income"
  fixed ([Architecture](architecture.md#category-service-15)). The others are
  regular, editable suggestions.
- Like every migration, it runs exactly once. If the user deletes or renames
  a default category, it does not come back.
- Tests that need an empty category table (e.g. the repository contract) use
  `createTestDb({ defaultCategories: false })`.
  `src/persistence/default-categories.test.ts` checks the seed data and that
  every position is valid according to `validateCategoryPosition`.

### Adding a new tax year

1. Get the official form and instructions of the Anlage EÜR for the year
   (BMF letter "Standardisierte Einnahmenüberschussrechnung nach § 60
   Absatz 4 EStDV; Anlage EÜR <Jahr>", bundesfinanzministerium.de).
2. Add a constant `ANLAGE_EUER_<YEAR>` in `line-mapping.ts` (source with
   date, GZ and version in the comment), check every position against the
   form and add it to `EUER_LINE_MAPPINGS` (a provisional year may point to
   the previous year). Leave out lines that cannot be verified – the fallback
   then applies.
3. Pin the year's lines in `line-mapping.test.ts`.
4. If the domain logic changes (e.g. a line is split), add a new position;
   old keys stay.

## EÜR calculation (#25)

`calculateEuer` (`src/business/euer/calculate-euer.ts`) is a pure function;
`EuerService.calculate(year)` (`services.euer`) loads in **one** unit of work
the tax status (`TaxYearRepository.find`, regularly taxed without a record),
all categories (including archived ones) and the year's sums from
`BookingRepository.sumByCategoryAndVatRate(year)` – an aggregate query over
the year's date range (payment date), grouped by category, type and VAT rate
(count, gross, net, VAT). An invalid year returns, without database access,
`{ ok: false, reason: "invalid", errors: [{ field: "year", code: "invalidYear" }] }`.

### Rules

| Case                               | Regularly taxed                                                      | Small business                              |
| ---------------------------------- | -------------------------------------------------------------------- | ------------------------------------------- |
| Amount in the category's position  | Net                                                                  | Gross                                       |
| VAT share (rate `7`/`19` only)     | income → `UST_VEREINNAHMT`, expense → `VORSTEUER`                    | no VAT positions                            |
| Turnover category (line 15/16)     | rate `7`/`19` → 15, rate `0`/`reverse_charge`/no rate → 16           | → `BETRIEBSEINNAHMEN_KLEINUNTERNEHMER` (12) |
| Line 13 (informational)            | –                                                                    | amounts of the categories with `_UST_FREI`  |
| Income reduction (`reducesIncome`) | net reduces 15 or 16 (by rate), VAT share reduces `UST_VEREINNAHMT`  | gross reduces 12 (with `_UST_FREI` also 13) |
| `UST_ERSTATTUNG`, `UST_AN_FA`      | **gross** in line 18 or 58/59, never VAT lines (even with rate 7/19) | gross, unchanged                            |
| `BEWIRTUNG`                        | net, 70 % of it counts; input tax in full                            | gross, 70 % of it counts                    |
| other expenses                     | net into the position                                                | gross into the position                     |

Decisions (the formerly open points):

- **Status of the year, not the booking's rate.** In a small business year
  the gross amount always counts; a stored rate is ignored (no VAT
  positions, rate `0` does not lead to line 13 either). In a regularly taxed
  year a booking without a rate counts with net = gross and VAT 0 (that is
  how it is stored); income without a rate goes to line 16 like rate `0`.
  The result reports mismatching bookings (#16) as warnings
  `vatRateInSmallBusinessYear` or `vatRateMissingInRegularYear` with a count.
- **Line 15 or 16 by rate.** For turnover categories (positions with a small
  business target: `BETRIEBSEINNAHMEN_UST_PFLICHTIG`/`_UST_FREI`), in a
  regularly taxed year the booking's rate decides, in **both** directions:
  `0`, reverse charge or no rate → 16, `7`/`19` → 15 – even income at 19 % in
  "Steuerfreie / nicht steuerbare Erlöse" is taxable, line 16 would be
  wrong. Income reductions likewise. `UST_ERSTATTUNG` stays in line 18.
- **Payments to / refunds from the tax office** (`UST_AN_FA`,
  `UST_ERSTATTUNG`, marked as `taxOfficePayment` in
  `EUER_POSITION_DEFINITIONS`, `isTaxOfficePayment`) contain no VAT: per the
  instructions, the full amounts paid or refunded go into line 18 or 58/59.
  The calculation therefore always counts the **gross amount** in the
  position and never a VAT share – even if the booking (by mistake, the form
  starts with 19 %) has rate `7`/`19`; then warning `vatRateOnTaxPayment`
  with a count (regularly taxed only; in a small business year
  `vatRateInSmallBusinessYear` already applies). When such a category is
  selected, the booking form sets the rate to `0` and shows a hint; the
  booking service validates as before.
- **Categories only via position and flag**, at calculation time (changes
  apply retroactively, #15), never via the name. Archived categories count
  normally.
- **Income reduction:** the VAT share of a refund in a regularly taxed year
  reduces `UST_VEREINNAHMT` (correction of the VAT owed, § 17 UStG), not
  `VORSTEUER`.
- **Negative lines** (income reduction larger than the line's income) stay
  negative and count that way in the totals; warning `negativeLine` with the
  position. Typical case: refunds of a previous year's sales exceed the
  line's sales this year (the payment date decides). That is permitted – the
  Anlage EÜR accepts negative amounts (with a minus). Wording for #26, for
  example: "Line X is negative because refunds exceed this line's income
  (e.g. repayments for sales from previous years). Please check the
  assignment."
- **Line 13** (small business) is derived before the redirection from the
  amounts of the categories with `BETRIEBSEINNAHMEN_UST_FREI` (including
  their income reductions); informational only (`informational`, not in the
  total, already included in line 12). This is an approximation: line 16
  also covers tax-exempt sales under § 4 UStG that do not fall under § 19
  Abs. 2 Satz 1 Nr. 1 and 2 UStG.
- **Entertainment (Bewirtung, line 63, 2026: 64)** has the columns "not
  deductible" and "deductible" (§ 4 Abs. 5 Satz 1 Nr. 2 EStG). The line
  carries `entertainment: { totalCents, deductibleCents, nonDeductibleCents }`:
  30 % is not deductible, rounded half-up **once** on the annual total
  (`splitEntertainment`), the deductible part is the remainder. Only the
  deductible part is the line's amount (`amountCents`) and counts towards
  expenses and profit; the non-deductible part only appears in its column.
  Input tax on entertainment counts in full in `VORSTEUER` (the 70 % limit
  only applies to income tax). Warning `entertainmentSplit`. Limits: the app
  checks neither appropriateness nor documentation; fully deductible
  entertainment (e.g. employees only) belongs in another category.
- **Additional meal expenses (Verpflegungsmehraufwand, line 64, 2026: 65)**
  are deductible only up to the flat rates. The app knows neither travel
  days nor flat rates and counts the amounts as recorded – users should book
  the flat rate as the amount. Warning `mealAllowanceFlatRates`.
- **§ 13b UStG as service recipient:** the VAT paid to the tax office goes
  through the category with `UST_AN_FA` (expense). The incoming service
  itself has rate `reverse_charge` (net = gross, no input tax). In a small
  business year that is correct (no input tax deduction). In a regularly
  taxed year the VAT return offsets VAT owed and input tax under § 13b; the
  app does not model either as separate amounts (effect on profit: zero).
- **Unassignable bookings** (category missing, category type does not match
  the booking, position unknown or invalid according to
  `validateCategoryPosition` – e.g. a key from a newer app version) do
  **not** count; warning `unassignableBookings` with count and category IDs.
  Such data does not arise through the services.

### Amounts

- Integer cents. The **stored** net and VAT amounts per booking are summed
  (`sum(net_cents)`, `sum(vat_cents)`), never recomputed from gross sums:
  three times 0.10 € at 19 % is 0.24 € net and 0.06 € VAT, not 0.25 € and
  0.05 €. `MAX_AMOUNT_CENTS` keeps all sums exact.
- Profit = income − expenses (without informational lines); negative =
  loss.

### Result (`EuerResult`)

```ts
{
  year, smallBusiness,
  hasLineMapping,                  // false → UI shows position names (#26)
  income: EuerReportLine[],        // by line; without mapping in position order
  expenses: EuerReportLine[],
  informational: EuerReportLine[], // line 13, not in the totals
  totals: { incomeCents, expenseCents, profitCents },
  warnings: EuerWarning[],         // codes in fixed order (see EuerWarning)
}
EuerReportLine = {
  position, line?, label?,         // line/label only with mapping (describePosition)
  amountCents,                     // counts like this in the total (entertainment: deductible part)
  bookingCount,
  entertainment?,                  // BEWIRTUNG only
  contributions: { categoryId, bookingType, vatRates, bookingCount, amountCents }[],
}
```

- **Which lines:** every position that at least one booking contributes to
  – even with a total of 0 (e.g. a sale and a full refund). Positions
  without bookings are missing. VAT lines arise from bookings with rate
  `7`/`19`.
- **Drill-down (#26):** `contributions` lists, per category and booking
  type, the contributing VAT rates, the count and the (signed) amount; the
  contributions add up to the line's total (entertainment:
  `entertainment.totalCents`). The bookings of a line are exactly: year +
  `categoryId` + `bookingType` + `vatRates` per contribution. Since #26 the
  booking search also filters by VAT rate (`vatRates`, URL `vat`); the view
  links the union of categories and rates – why that is exact:
  [Architecture](architecture.md#eür-annual-view-26).

## Migrations

```
src/persistence/migrations/
  0000_init.sql            ← SQL, statements separated by "--> statement-breakpoint"
  meta/_journal.json       ← order: entries[].idx / .tag (= file name without .sql) / .when
  meta/0000_snapshot.json  ← schema state for the next diff (drizzle-kit only)
```

- Change the schema → `pnpm db:generate` (optionally `--name <name>`) →
  commit the generated files. Migrations are never changed afterwards.
- Pure data migrations (e.g. default categories, #13) are created with
  `pnpm db:generate --custom --name <name>`: drizzle-kit creates an empty SQL
  file with a journal entry, which you fill yourself.
- CI checks that schema and migrations match: nothing may change after
  `pnpm db:generate`.
- The files are generated and excluded from oxfmt.

## Database at runtime (#10)

| File                                             | Responsibility                                                |
| ------------------------------------------------ | ------------------------------------------------------------- |
| `src-tauri/src/lib.rs`                           | Pool with exactly one connection, registered with the plugin  |
| `src/persistence/tauri-sql-client.ts`            | `SqlClient` over `tauri-plugin-sql` (`Database.get`)          |
| `src/persistence/connection.ts`                  | `SqlConnection`: serialises access, `exclusive`/`transaction` |
| `src/persistence/drizzle-proxy.ts`               | Callback for Drizzle's `sqlite-proxy`                         |
| `src/persistence/database.ts`                    | `Database` = `{ db, transaction }`, base of the repositories  |
| `src/persistence/bundled-migrations.ts`          | Migrations, bundled by Vite                                   |
| `src/persistence/migrator.ts`                    | Own migrator                                                  |
| `src/persistence/open-database.ts`               | `openDatabase(client)`: migrate, create `Database`            |
| `src/app/startup.ts`, `src/app/app-services.tsx` | Startup, loading/error screen, services via context           |

### File and connection

- **Location:** `%APPDATA%\de.belegwerk.desktop\belegwerk.db` (Tauri
  `app_data_dir` of the identifier; on Windows identical to `app_config_dir`,
  which the plugin itself uses). Name in the plugin: `sqlite:belegwerk.db`.
  Debug builds (`pnpm tauri dev`) open the file `belegwerk-dev.db` under the
  same plugin name (`DB_FILE` in `src-tauri/src/lib.rs`), so development and
  tests never touch the real data.
- **Exactly one connection.** Via `Database.load`, `tauri-plugin-sql` opens
  an sqlx pool with up to ten connections; individual `execute` calls for
  `PRAGMA`, `BEGIN`, statements and `COMMIT` would then end up on different
  connections. That is why the Rust host opens the database itself
  (`SqlitePoolOptions` with `max_connections(1)` and no idle/lifetime expiry,
  so an open transaction does not disappear with the connection) and puts
  the pool into the plugin's `DbInstances`. The frontend uses `Database.get`
  (no `load`); the capability only contains `sql:allow-execute` and
  `sql:allow-select` – `load` (would replace the pool) and `close` are not
  allowed. This is pure plugin configuration, no logic in Rust.
- **Serialised in JS:** One connection is not enough when two async flows
  interleave. `SqlConnection` queues all calls; `exclusive(fn)` gives one
  flow the connection for a whole sequence, `transaction(fn)` builds
  `BEGIN IMMEDIATE` … `COMMIT`/`ROLLBACK` on top of it.
- **Foreign keys:** sqlx sets `PRAGMA foreign_keys = ON` when opening each
  connection (default, also explicit in the host); the migrator switches it
  back on at the end.
- **Journal mode:** not set, so SQLite's default `DELETE` (one file, no
  `-wal`) – simple for backups (M7, [#32](#backup-and-restore-32)).
- **WebView reload:** The connection lives on in the host. `openDatabase`
  therefore rolls back a transaction that may have been left open.

Verified in the running app (#10): a `TEMP` table is only visible on the
connection that created it. 40 parallel queries on it all succeed with the
own pool; with a default pool opened via `load`, 28 of 40 failed
(`no such table`). Likewise `PRAGMA foreign_keys = OFF` persists across
calls.

### Backup and restore (#32)

**Backup:** Einstellungen → Datensicherung → "Backup erstellen" writes a
consistent copy of the whole database via `VACUUM INTO` (one SQLite file,
suggested `belegwerk-backup-YYYY-MM-DD_HHMM.db`) and verifies it
([Architecture](architecture.md#backup-32)). The backup contains all data
including the Stripe key (plain text).

**Never save backups in the app's data folder**
(`%APPDATA%\de.belegwerk.desktop` and below): the app rejects such a target
before any write ("Das Backup kann nicht im Datenordner der App gespeichert
werden …"), because overwriting `belegwerk.db` or its journal would destroy
the running database. The folder would also be deleted on uninstall or
reset. Not detected are detours via symbolic links, junctions, hard links,
mapped drives, UNC paths to the own machine (`\\localhost\C$\…`,
`\\<machine name>\…`) or 8.3 short names of the folder
([Architecture](architecture.md#backup-32)).

**Restore (manual)** (for users: [Handbuch](handbuch.md#datensicherung)):

1. Close Belegwerk (close the window; no `belegwerk.exe` process may still
   be running, otherwise the file is locked).
2. Open the folder `%APPDATA%\de.belegwerk.desktop` (Explorer address bar).
3. Rename or move away the existing `belegwerk.db` to be safe, e.g. to
   `belegwerk-vorher.db`.
4. Copy the backup file into this folder and rename it to `belegwerk.db`.
5. If there is a `belegwerk.db-journal` (only after a crash in the middle of
   a write), it belongs to the old database: delete it or move it along –
   otherwise SQLite would apply it to the backup. There are no `-wal`/`-shm`
   files (journal mode `DELETE`).
6. Start Belegwerk.

Behaviour on startup:

- **Backup from an older app version:** the migrator applies the missing
  migrations; afterwards the database matches the app.
- **Backup from a newer app version** (contains migrations the app does not
  know): startup aborts with the error screen (`MigrationError`
  `unknown_migration`); the file stays unchanged. Then install the newer app
  version or put the old `belegwerk.db` back.
- **Not a valid SQLite file** (e.g. empty after a failed backup): an empty
  file is treated like a new database (empty database with default
  categories) – so check before replacing that the backup file is not 0
  bytes.

### Drizzle (`sqlite-proxy`)

`createProxyCallback` maps Drizzle's methods to the client: `run` →
`execute`, `all`/`values` → `select` with rows as value arrays, `get` → first
row or `undefined`. Parameters: booleans become `1`/`0`, `undefined` becomes
`NULL`; BigInt, objects and bytes are rejected.

- **Unique column names.** The plugin returns rows as objects; Drizzle reads
  values by position. Duplicate names (e.g. `id` from two tables in a join)
  would collapse into one key – alias such columns
  (``sql<number>`${categories.id}`.as("category_id")``). The test client
  rejects duplicate names, so persistence tests catch it. The adapter rejects
  purely numeric column names (JS sorts them to the front).
- **Numbers** are always bound as `REAL` by the plugin (like
  `better-sqlite3`). In `INTEGER` columns SQLite converts back losslessly;
  in a `TEXT` column, however, `2025` would become `'2025.0'` – do not bind
  numbers to text columns.
- **Transactions only via `Database.transaction(async (tx) => …)`.**
  Drizzle's `db.transaction()` sends `begin`/`commit` as individual calls
  that other flows could slip between; the adapter therefore rejects
  transaction statements. Use only `tx` inside the callback – `db` waits for
  the transaction to end (deadlock). Repositories wrap this as `UnitOfWork`
  ([Architecture](architecture.md#transactions-only-via-unitofworkrun)). If a
  call waits more than 10 s for the connection, `SqlConnection` reports it
  via `console.error` as a hint at such a deadlock.
- **`db.batch([...])`** runs atomically in one transaction.
- **Errors:** Drizzle wraps database errors in `DrizzleQueryError`
  ("Failed query: …"); the SQLite message (e.g. `UNIQUE constraint failed`)
  is in `cause` (an `SqlError`).

### Loading in the WebView

The app's migrator cannot read the file system (so Drizzle's own
`sqlite-proxy` migrator is ruled out). The migrations are bundled by Vite
(`bundled-migrations.ts`):

```ts
import journal from "./migrations/meta/_journal.json";

const files = import.meta.glob<string>("./migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
// order from journal.entries; SQL = files[`./migrations/${entry.tag}.sql`],
// split at "--> statement-breakpoint".
```

Only drizzle-kit needs the snapshots (`meta/*_snapshot.json`); they are not
imported and do not end up in the bundle.

### Migrator

Tracking table `__migrations`:

| Column       | Contents                                           |
| ------------ | -------------------------------------------------- |
| `idx`        | Position in the journal (PK)                       |
| `tag`        | File name without `.sql`, unique                   |
| `hash`       | SHA-256 of the SQL (line endings normalised to LF) |
| `applied_at` | Time of application (`toISOString()`)              |

On startup the applied migrations are checked; startup aborts with
`MigrationError` (error screen) if

- `hash_mismatch`: an applied migration was changed afterwards (migrations
  are never changed),
- `unknown_migration`: the DB contains a migration the app does not know
  (DB of a newer version),
- `order_mismatch`: the applied ones are not exactly the first ones of the
  journal,
- `foreign_key_violation`: foreign keys are violated after migrating.

**Protocol.** If a migration changes a table that SQLite cannot change via
`ALTER TABLE`, drizzle-kit rebuilds it (create `__new_<table>`, copy, drop
the old one, rename) and writes `PRAGMA foreign_keys=OFF` before it.
**Inside a transaction SQLite ignores this pragma** – for a parent table like
`categories` the `DROP TABLE` would fail. That is why everything runs in an
`exclusive` section of the connection:

1. `PRAGMA foreign_keys = OFF` (outside any transaction),
2. `BEGIN IMMEDIATE`, create and check the tracking table, run and record
   all pending migrations,
3. `PRAGMA foreign_key_check` – if it returns rows: `ROLLBACK` and error,
4. `COMMIT` (on any error `ROLLBACK` instead, also for the tracking table),
5. `PRAGMA foreign_keys = ON` (also after an error; if that itself fails,
   the original error is reported, not the pragma's).

### Notes for repositories (#11 ff.)

- Repositories (`src/persistence/repositories/`) are factories over a
  Drizzle instance (`Db`): `database.db` for single queries or `tx` in
  `Database.transaction`. `createAppServices` (`src/app/services.ts`)
  creates them; UI and routes only receive business interfaces
  (`useAppServices()`). Details:
  [Architecture](architecture.md#repositories-and-unit-of-work-11).
- **Joins** never as `select().from(a).innerJoin(b)` (duplicate column
  names), but with an explicit select object and unique aliases.
- **`onConflictDoNothing` (Stripe import, #30):** Drizzle 0.45 generates
  invalid SQL for the partial index with `onConflictDoNothing({ target, where })`.
  Use the bare `.onConflictDoNothing()` instead (applies to every unique
  conflict) or query existing `external_id`s beforehand.
- Tests use `createTestDb()` from
  [`src/persistence/__tests__/test-db.ts`](../src/persistence/__tests__/test-db.ts):
  in-memory `better-sqlite3` behind the same `openDatabase` as the app
  (migrator, proxy adapter, `SqlConnection`) – only the plugin is replaced.
