# Architecture

Tauri v2 is only the host; all logic runs in TypeScript inside the WebView –
the only exception is the auto-update ([#71](#auto-update-71)), whose network
access and file swap run in Rust. The code under `src/` is organised in
layers whose dependencies point in one direction only. **oxlint**
(`no-restricted-imports`) enforces the boundaries, see
[`.oxlintrc.json`](../.oxlintrc.json).

```
src/routes ─┬──────────────────► src/app ──────────────┐
src/ui ─────┤                   (composition root)     │ wires up
            │                        │                 ▼
            └──► src/business ◄──────┴────────── src/persistence
```

Arrows = "imports from". `src/app` imports from all layers; UI and routes get
services via `src/app`, never directly from `src/persistence`.

## Folders

| Folder            | Contents                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `src/routes`      | TanStack Router routes (file-based). Thin: read parameters, call services, render UI.                                         |
| `src/ui`          | Presentation: components, styles. `src/ui/components/ui` contains the generated shadcn/ui components.                         |
| `src/business`    | Domain logic: calculations, validation, services, formatting – and the **repository interfaces (ports)**. No React, no Tauri. |
| `src/persistence` | Drizzle schema, migrations and the implementations of the repository interfaces from `src/business`.                          |
| `src/app`         | Composition root: creates DB, repositories and services and provides them to the UI (app startup).                            |

Generated and excluded from lint/format: `src/routeTree.gen.ts` (TanStack
Router) and `src/paraglide/` (Paraglide, git-ignored). Also generated, but
checked in and only excluded from oxfmt: `src/persistence/migrations/`
(drizzle-kit, see [Data model](data-model.md)).

## Import rules

| Layer                  | must not import from                                                                                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/ui`, `src/routes` | `src/persistence`, `drizzle-orm`, `drizzle-kit`, `better-sqlite3`, `@tauri-apps/plugin-sql`                                                                                                                                                                                    |
| `src/business`         | `src/persistence`, `src/ui`, `src/routes`, `src/app`, `src/router.tsx`, `src/routeTree.gen.ts`, `src/paraglide`, React packages (`react`, `react-dom`, `@tanstack/react-*`, `@base-ui/react`, …), `@tauri-apps/*`, `drizzle-orm`, `drizzle-kit`, `better-sqlite3`; also no JSX |
| `src/persistence`      | `src/ui`, `src/routes`, `src/app`, `src/router.tsx`, `src/routeTree.gen.ts`, React packages; outside of tests (`__tests__/`, `*.test.ts[x]`) additionally `better-sqlite3`, `drizzle-kit`, `drizzle-orm/better-sqlite3` and `node:*` (runs in the WebView)                     |
| `src/app`              | – (may import anything)                                                                                                                                                                                                                                                        |

Both the alias (`@/persistence/...`) and relative paths
(`../persistence/...`, `../../persistence`) are covered, each for `import`,
`import type` and `export … from`.

**Known gap (accepted):** The rules work on the import string, not on the
resolved path. Non-normalised paths like `./../persistence` or
`@/ui/../persistence` are not detected. Nobody writes such paths by
accident; reviews catch them.

### No JSX in `src/business`

Business contains no `.tsx` components. oxlint reports JSX in `src/business`
via `react/jsx-filename-extension` (no extension may contain JSX); React
imports are forbidden anyway. A `.tsx` file without JSX is not reported –
business files are `.ts` nonetheless.

### No UI texts in `src/business`

Business does not import from `src/paraglide`. It returns codes (e.g. error
codes of `parseAmount`); translation happens in `src/ui` or `src/routes`
(see [`docs/i18n.md`](i18n.md)).

### `src/app` provides services

`src/app` hands **services** (or business interfaces) to UI and routes and
never re-exports modules from `src/persistence` (schema, Drizzle instance,
repository implementations). Otherwise the rule "UI does not import from
persistence" could be bypassed via `@/app`; lint cannot detect that.

### Repository interfaces live in `src/business`

Business works only against interfaces, but must **not** import from
`src/persistence` at all – not even `import type`. Instead, dependency
inversion applies:

- The interfaces (e.g. `BookingRepository`, `CategoryRepository`) and the
  domain types they use live in `src/business` (#11).
- `src/persistence` imports these interfaces/types from `src/business` and
  implements them with Drizzle. Drizzle row types (`$inferSelect` etc.) stay
  in `src/persistence` and are mapped to domain types there.
- `src/app` wires both together; business tests use in-memory fakes of the
  interfaces.

That way the rule stays a simple "business imports nothing from
persistence", and business does not depend on the DB schema.

UI and routes also must not import `drizzle-orm`, `drizzle-kit`,
`better-sqlite3` or `@tauri-apps/plugin-sql` – database access only exists
in `src/persistence`.

## Repositories and unit of work (#11)

| File                                               | Contents                                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/business/model.ts`                            | Domain types: `Booking`, `BookingInput`, `Category`, `CategoryInput`, `CategoryChanges`, `TaxYear`, enums     |
| `src/business/repositories.ts`                     | Interfaces `BookingRepository`, `CategoryRepository`, `TaxYearRepository`, `SettingsRepository`, `UnitOfWork` |
| `src/persistence/repositories/`                    | Drizzle implementations, `createRepositories(db, clock)`, `createUnitOfWork(database, clock)`                 |
| `src/business/__tests__/in-memory-repositories.ts` | In-memory fakes for business tests (`createInMemoryDatabase({ clock })`)                                      |
| `src/business/__tests__/repository-contract.ts`    | Shared contract tests, run against the fakes **and** Drizzle (better-sqlite3)                                 |

- **Thin:** Repositories read and write without domain rules. The services
  (#14 ff.) check required fields, amounts, category type, archived
  categories and tax status. Domain types instead of Drizzle rows; date
  `YYYY-MM-DD`, amounts in cents, timestamps as `toISOString()`.
- **Clock:** The booking repository sets `created_at`/`updated_at` via an
  injected `Clock` (`() => Date`); tests provide a fixed clock.
- **Constraint violations** (unique index, foreign key) surface as
  `ConstraintViolationError` with `kind: "unique" | "foreign_key"` from
  `src/business`. Services check beforehand themselves (better messages);
  the error is the safety net. The kind is only detected from the database's
  error (`SqlError` or SQLite code), not from Drizzle's outer error – whose
  message contains the bound parameters, i.e. user input. The message of the
  `ConstraintViolationError` contains no parameters either. CHECK violations
  are not translated – they indicate a validation bug in the service (e.g.
  "reduces income" on an income category).
- **Search (#21):** `BookingRepository.search({ filter, sort, limit?, offset? })`
  returns the matching bookings sorted (optionally a window),
  `summarize(filter)` the count and gross sums per type of all matching
  bookings – filtering, sorting, paging and summing in SQL. Details under
  [Booking search](#booking-search-21). The EÜR (#25) reads
  `sumByCategoryAndVatRate(year)`: sums per category, type and VAT rate in
  one aggregate query. The form's text suggestions read
  `listTextUsage(field)`: per exact text (description or counterparty) and
  type, the count and latest date (`GROUP BY`).

### Transactions only via `UnitOfWork.run`

Writes that belong together run in `unitOfWork.run(async (repos) => …)`:
`COMMIT` if the callback resolves, otherwise `ROLLBACK` and the error is
rethrown.

**Rule: inside the callback, use only the `repos` passed in.** The database
has exactly one, serialised connection ([Data model](data-model.md)). A call
via the outer repositories (or a nested `run`) queues up behind the running
transaction – which only ends when the callback is done: **deadlock**, the
app hangs. Therefore:

- Services get repositories/unit of work injected and, inside `run`, pass
  the callback's `repos` on (e.g. to helper functions) instead of accessing
  their own fields.
- The in-memory fakes throw immediately in this case, so business tests
  catch it.
- In the app, `SqlConnection` reports via `console.error` when a call waits
  more than 10 s for the connection (a hint at this rule).

The persistence implementations are therefore factories over a Drizzle
parameter (`createBookingRepository(db, clock)`): `createUnitOfWork` creates
them anew for each transaction on its `tx`.

### Contract tests

`describeRepositoryContract(name, setup)` describes the behaviour of all
implementations (IDs of committed rows are never reused, one assigned in a
rolled-back unit of work is; return values, constraint errors, rollback). It
runs in `src/business/__tests__/in-memory-repositories.test.ts` against the
fakes and in `src/persistence/repositories/repositories.test.ts` against
Drizzle on `better-sqlite3` – so the fakes cannot drift from the real
behaviour, and every repository query runs through the test client, which
rejects duplicate result column names. New repository methods get their
cases in the contract. Of the DB's CHECK constraints, the fakes only mimic
"reduces income only for expense categories" (plain `Error`); the services
check the others (amounts, date, enum values).

**Joins:** no `select().from(a).innerJoin(b)` – columns with the same name
(`id`, `type`, …) would collapse into one value in the plugin. Use an
explicit select object with unique names instead
([Data model](data-model.md#drizzle-sqlite-proxy)).

### Platform access

Business is free of Tauri. If logic needs platform functions (HTTP for
Stripe, files for CSV), business defines an interface; the implementation
with `@tauri-apps/*` lives outside `src/business` and is wired up in
`src/app`. Likewise `drizzle-orm`, `drizzle-kit` and `better-sqlite3` are
forbidden in business – Drizzle only exists in `src/persistence`.

**Saving files (#24, also EÜR #27):** port `FileSaver`
(`src/business/files.ts`, `saveTextFile({ defaultFileName, filter, content })`
→ `{ saved: true, path }` or `{ saved: false }` on cancel; write errors
throw). Implementation `createTauriFileSaver()` in
`src/app/tauri-file-saver.ts`: save dialog `save()` from
`tauri-plugin-dialog`, then `writeTextFile()` from `tauri-plugin-fs` (UTF-8,
unchanged). `createAppServices(database, clock, fileSaver)` wires it up;
tests pass a fake.

- **Capabilities** (`src-tauri/capabilities/default.json`), as narrow as
  possible: `dialog:allow-save` and `fs:allow-write-text-file` – **without**
  a configured fs scope. The dialog adds the chosen path to the fs scope at
  runtime (`allow_file` in `tauri-plugin-dialog`); so exactly the file the
  user chose can be written, no other path (not even AppData). No
  `fs:default` (read access to app folders) and not `fs:allow-write-file`
  (additionally allows `open`/`write`).
- The added path stays in the scope until the program exits (plugin
  behaviour). Until then the WebView can write to this file again – also
  append: `fs:allow-write-text-file` allows the `append: true` option of
  `writeTextFile`, a capability cannot switch that off. The export does not
  use it; it writes without options (create or replace, `truncate`), and the
  dialog asks before overwriting.
- The plugins only talk via IPC (`ipc:`/`http://ipc.localhost`) – the CSP
  needs no extension.

## Money and VAT (#12)

`src/business/money` computes net and VAT from gross and VAT rate – only
with integer cents and exact integer arithmetic (BigInt, no floating point).

- **Rounding:** The included VAT is `gross × rate / (100 + rate)`, rounded
  half-up (from ½ cent up); net is the remainder (`net = gross − vat`). That
  is how receipts and invoices state the included VAT, and
  `net + vat = gross` holds by construction. With 7 % and 19 % the
  denominators 107 and 119 are odd – a quotient never ends on exactly ½
  cent, so "VAT first" and "net first" always give the same result (proven
  in the tests).
- **`splitGross(grossCents, vatRate)`:** `'7'`/`'19'` with VAT; `'0'`,
  `'reverse_charge'` and `null` (no rate, small business) with VAT 0 and
  net = gross. Invalid arguments (gross not a positive safe integer, unknown
  rate) are programming errors → `RangeError`; the service checks
  "amount > 0" beforehand.
- **`calculateBookingAmounts(grossCents, vatRate, smallBusiness)`:**
  additionally the year rule (#14, #16) as a result object: in a small
  business year a rate is `"vatRateNotAllowed"`, in a regularly taxed year a
  missing one is `"vatRateRequired"`. With `ok: true`, `netCents`,
  `vatCents`, `vatRate` fit directly into `BookingInput`.

## Booking service (#14)

`src/business/bookings` – `createBookingService({ unitOfWork })` with
`list(query?)`, `get(id)`, `create(input)`, `update(id, input)`,
`delete(id)`. The input is `BookingFormInput` (what the form submits): date,
type, gross in cents, VAT rate, category, description, counterparty,
reference, note, optionally source and external ID. The service never
accepts net/VAT, it computes them (`calculateBookingAmounts`).

- **One unit of work per operation:** category, tax year and external IDs
  are read in the same transaction that writes; a failed validation writes
  nothing.
- **Result objects instead of exceptions:** `{ ok: true, booking }`,
  `{ ok: false, reason: "invalid", errors }` or
  `{ ok: false, reason: "notFound" }` (`get`, `update`, `delete`; also for an
  invalid ID like `NaN`, without database access). `errors` contains **all**
  field errors (at most one per field, in form order) as `{ field, code }` –
  the form (#18) shows them at the field and translates the codes
  (`BookingFieldErrorCodes`). Programming errors throw.
- **Rules in one place:** `prepareBooking(input, lookups, existing?)`
  validates, normalises and computes the amounts without writing; reads go
  through `BookingLookups` (`repositoryBookingLookups(repos)` in the service,
  preloaded data in the Stripe import #30).
- **Rules:** date an existing `YYYY-MM-DD` with year 1000–9999
  (`parseIsoDate`, like the DB CHECK); gross an integer > 0 and at most
  `MAX_AMOUNT_CENTS`; VAT rate known and matching the tax status of the
  year from the date (regularly taxed without a record); category chosen
  (positive integer, otherwise `required` – e.g. `NaN` from an empty select),
  exists and matches the type. **Archived categories:** not for new bookings
  and not as a new category when editing; but a booking may keep its
  meanwhile archived category (otherwise it could no longer be edited after
  archiving).
- **Maximum amount** `MAX_AMOUNT_CENTS` (`src/business/money/limits.ts`):
  100,000,000.00 € per booking, shared by `parseAmount` (`tooLarge`) and the
  service (`amountTooLarge`). That keeps sums exact JS numbers:
  `Number.MAX_SAFE_INTEGER` holds about 900,000 bookings at the maximum
  amount – sums of the search (#21) and the EÜR (#25) need no BigInt.
- **Texts** are trimmed (`trimText`), including invisible format characters
  (`\p{Cf}`, e.g. U+200B–U+200D, U+2060, U+00AD, U+FEFF) and Unicode spaces
  (`\p{Z}`) at the edges; inner whitespace, line breaks and inner format
  characters (e.g. ZWJ in emojis) stay. A text without a visible character
  counts as empty; empty optional texts become `null`. Description,
  counterparty, reference and note are stored NFC-normalised (so the search
  #21 finds them even with decomposed input), the external ID stays
  unchanged. Maximum lengths after trimming (`BOOKING_TEXT_MAX_LENGTH`):
  description 500, counterparty 200, reference 200, note 2000, external ID
  255 characters.
- **Reference and note** are required properties (`string | null`); `null`
  or an empty string clears them. Only **source and external ID** may be
  missing (`undefined`): `create` sets the defaults (`"manual"`, `null`),
  `update` keeps the current value – so a Stripe booking stays one, even
  though the form does not show source and external ID.
- **Source and external ID** are purely informational. Only the unique index
  on `(source, external_id)` is checked beforehand (`externalIdDuplicate`). A
  `ConstraintViolationError` on write (race) is mapped explicitly: `unique` →
  `externalIdDuplicate`, `foreign_key` → `categoryNotFound`; everything else
  is rethrown.

- **`suggestTexts({ field, type?, limit? })`** (the form's text
  suggestions): previous values of description or counterparty, as a list of
  strings (`rankBookingTextSuggestions` in `booking-text-suggestions.ts`).
  **One entry per text, case-insensitive** (`toLocaleLowerCase("de")`, NFC:
  "Müller GmbH" = "MÜLLER GMBH"), shown in the most frequent spelling (then
  the most recent); usages are added up. **Order:** with `type`, first texts
  used with this type, then those used only with the other type (customers
  and suppliers differ but stay findable); each by count, then most recent
  date, then alphabetically. At most `limit` (default 300, max 1000) – enough
  for filtering while typing, small in memory. Unknown field, type or limit
  throws `RangeError` (programming error).
- **`list(query?)`** (booking list #17, search #21) returns one page of the
  matching bookings, each with `category: { id, name, archived }`, plus the
  total count and sums – see [Booking search](#booking-search-21).
  Categories come via `CategoryRepository.list()` in the same unit of work
  and are joined in the service – no N+1 and no SQL join with duplicate
  column names.

### Booking search (#21)

`BookingQuery` (`src/business/bookings/booking-query.ts`), all fields
optional and combined with AND:

| Field                    | Meaning                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `text`                   | Substring in description, counterparty, reference or note; case-insensitive, umlauts included                 |
| `dateFrom`, `dateTo`     | Payment date `YYYY-MM-DD`, each inclusive                                                                     |
| `type`, `source`         | Type or source                                                                                                |
| `vatRates`               | one of the VAT rates, `null` = without rate (#26; empty = all; duplicates ignored; unknown: `invalidVatRate`) |
| `categoryIds`            | one of the categories (empty = all; duplicates ignored; at most 500)                                          |
| `amountFrom`, `amountTo` | **Gross** in cents, each inclusive                                                                            |
| `sort`                   | `{ field, direction }`, fields `BOOKING_SORT_FIELDS`; default date descending                                 |
| `page`, `pageSize`       | Page from 1 (default 1); size 1–500 (default 50) or `"all"`                                                   |

Result of `BookingService.list(query)`: `{ ok: true, items, total, page,
pageSize, pageCount, sums: { incomeCents, expenseCents, balanceCents } }` or
`{ ok: false, reason: "invalid", errors }`.

- **Validation** (`normalizeBookingQuery`, also usable on its own, e.g. for
  the URL schema #22): errors as codes per field (`BookingQueryErrorCodes`),
  nothing is silently corrected – invalid dates (`invalidDate`), `dateTo`
  before `dateFrom` (`dateRangeInverted`, no swapping), amounts not an
  integer ≥ 0 (`invalidAmount`) or `amountTo` < `amountFrom`
  (`amountRangeInverted`), unknown sort (`invalidSort`), invalid page or page
  size. An invalid query does not hit the database. Text is trimmed
  (`trimText`) and NFC-normalised, max. 200 characters; control characters
  (`\p{Cc}`, e.g. NUL – `GLOB` would stop there – or line breaks) and lone
  surrogates are rejected (`invalidText`), not removed; empty texts/dates and
  empty `categoryIds`/`vatRates` do not filter.
- **Page past the last one** → the last page; `page` in the result is the
  one actually delivered (e.g. after deleting the last booking of a page).
  The UI (#23) can align its URL with it. `pageCount` is at least 1 (an
  empty result = one empty page).
- **`pageSize: "all"`** returns all matching bookings on one page – for the
  CSV export (#24), which uses the same filter and sort as the list.
- **Sums** over **all** matching bookings (not just the page), on a **gross
  basis**: income, expenses, balance = income − expenses (like a bank
  statement; the tax view with net/VAT and income reduction is the EÜR,
  #25). `MAX_AMOUNT_CENTS` keeps them exact.
- **Sorting:** texts (description, counterparty, category name) with SQLite
  `NOCASE` – case-insensitive only for ASCII, otherwise by code point
  (umlauts after `z`; SQLite has no real German collation without ICU).
  `type`/`source` by stored value. Ties: for `date` by `id` in the same
  direction, otherwise date descending, then `id` descending – a total
  order, stable across pages.
- **Flow:** one unit of work with `summarize` (count + sums, one aggregate
  query), then `search` with `LIMIT/OFFSET` of the page (clamped to the last
  one if needed), then the categories.
- **Case-insensitive free text:** SQLite `LIKE`/`lower()` only fold ASCII
  ("müller" would not find "MÜLLER"), custom SQL functions cannot be
  registered via `tauri-plugin-sql`, and a derived search column would need
  a fragile backfill. Instead, each character of the search text becomes the
  set of its case variants in JS (`textSearchCharClasses`:
  `toLowerCase`/`toUpperCase`, plus ß/ẞ), and the database compares
  character by character against that set via `GLOB`: `"Mü"` →
  `*[Mm][üÜ]*`. Wildcards in the search text (`*`, `?`, `[`) get their own
  sets and match literally; `%` and `_` are ordinary characters in `GLOB`
  anyway. Limits: mappings to multiple characters are missing (`ß` does not
  find `SS`), and texts stored in decomposed form (NFD) before #21 are not
  found by an NFC search text – since #21 the service stores description,
  counterparty, reference and note NFC-normalised. The in-memory fake builds
  a RegExp from the same sets; the contract test checks both alike.

## Category service (#15)

`src/business/categories` – `createCategoryService({ unitOfWork })` with
`list()`, `get(id)`, `create(input)`, `update(id, changes)`, `archive(id)`,
`reactivate(id)`, `delete(id)`. Same conventions as the booking service: one
unit of work per operation, result objects with field codes
(`CategoryFieldErrorCodes`), `notFound` also for an invalid ID without
database access, texts trimmed (`trimText`/`isId` from
`src/business/validation.ts`, shared with #14).

- **`list()`** returns all categories including archived ones (by `id`),
  each with `bookingCount` (one query: `BookingRepository.countByCategories()`
  with `GROUP BY`) – the management page (#19) groups by type and offers
  "delete" only when `bookingCount === 0`; the booking form (#18) filters by
  type and excludes archived ones.
- **`create({ name, type, euerPosition, reducesIncome })`** creates a regular
  category (`isSystem: false`, not archived). **`update(id, changes)`**
  changes `name`, `euerPosition`, `reducesIncome`; missing fields stay, the
  type is fixed. Position and flag are only checked when one of them
  changes – renaming never fails because of the position. Archived
  categories are editable.
- **Name:** trimmed and NFC-normalised, required, at most
  `CATEGORY_NAME_MAX_LENGTH` (100) characters, unique per type
  case-insensitively (`toLocaleLowerCase("de")`, "Büro" = "BÜRO", also with a
  combining umlaut) – also against archived categories, since the DB's
  unique key includes them. Codes: `required`, `tooLong`, `nameDuplicate`.
- **Position/flag:** `validateCategoryPosition`, codes distributed over the
  fields: `euerPosition` gets `required` (empty), `unknownPosition`,
  `positionNotAssignable`, `positionKindMismatch`,
  `reducesIncomeNeedsIncomePosition`, `reducesIncomeNeedsTurnoverPosition`;
  `reducesIncome` gets `invalidValue` (not a boolean – checked at runtime
  like `type`; the position is then checked without the flag) or
  `reducesIncomeNotExpense` (income category; the position is then checked
  as for a regular income category). With an invalid type
  (`type: invalidType`) only the type-independent checks run.
- **Changing the position applies retroactively:** bookings store only the
  category; the EÜR (#25) takes the category's position and flag at
  calculation time. No booking is rewritten.
- **System categories** (`isSystem`: USt-Vorauszahlung, USt-Erstattung,
  Erlösminderung / Rückerstattung): renamable, but not archivable or
  deletable (`{ ok: false, reason: "systemCategory" }`); position and flag
  are fixed (`systemCategoryFixed` on the respective field, only when the
  value changes). Reactivating is always allowed. Contract for #25: the EÜR
  recognises these categories by position and flag, **never by name**.
- **Archive/reactivate** is idempotent; archived categories stay valid for
  their bookings (see booking service). A name conflict on reactivation is
  impossible (the unique key includes archived ones).
- **Delete** only without bookings: the count is checked in the same unit of
  work, otherwise `{ ok: false, reason: "inUse", bookingCount }` (hint:
  archive). A `foreign_key` `ConstraintViolationError` (race) also becomes
  `inUse` (`bookingCount` at least 1); `unique` on create/update becomes
  `nameDuplicate`; everything else is rethrown.

## Tax year service (#16)

`src/business/tax-years` – `createTaxYearService({ unitOfWork })` with
`get(year)`, `list()`, `addYear(year)`, `setSmallBusiness(year, value,
options?)`. Same conventions as the booking and category services (one unit
of work per operation, result objects with field codes
`TaxYearFieldErrorCodes`).

- **Regularly taxed by default:** a year without a record in `tax_years` is
  regularly taxed. `get` returns `{ year, smallBusiness, explicit }`
  (`explicit` = record exists).
- **`list()`** returns all years with a record **or** with bookings
  (`BookingRepository.listYears()`), ascending; years with only bookings
  appear with the default (`explicit: false`). That way the settings page
  (#20) also shows years that were never set deliberately. Each year carries
  `mismatchedBookings` (`TaxYearOverview`): the number of bookings whose VAT
  rate does not match the status (counted only for years with bookings, in
  the same unit of work).
- **`addYear(year)`** ("Jahr hinzufügen", #20) creates the year as regularly
  taxed, e.g. to set the status before the first booking; if a record already
  exists: `yearExists`. `setSmallBusiness` also creates missing records.
- **Validation:** year a safe integer 1000–9999 (`invalidYear`, like the
  booking date and the DB CHECK; `get`/`addYear` without database access),
  value a boolean at runtime (`invalidValue`).
- **Status change with existing bookings:** if a year switches to small
  business, its bookings **with** a VAT rate no longer match; when switching
  to regularly taxed, those **without** a rate ("mismatched bookings"). Such a
  change is rejected with `{ ok: false, reason: "conflicts",
  mismatchedBookings }` – nothing is written. The UI asks and retries with
  `{ acknowledgeConflicts: true }` (only `true` counts); then it saves, and
  the result names `mismatchedBookings`. Check and write run in the same
  unit of work. If the status stays the same, there is no conflict
  (`mismatchedBookings` still counts remaining mismatched bookings).
- **Bookings are never rewritten:** when switching to regularly taxed, it
  cannot be derived which rate applies. A mismatched booking stays loadable
  and deletable; on the next save the booking service demands a rate
  matching the year (`vatRateNotAllowed` or `vatRateRequired`) – the form
  (#18) shows the VAT field according to the year's status.
- **Why not simply block:** a mismatched booking cannot be brought into the
  target state beforehand while the year has the old status (the booking
  service checks against the current status). A hard ban would only leave
  deleting and re-entering all of the year's bookings.

## Stripe settings (#28)

`src/business/stripe` – `createStripeSettingsService({ unitOfWork })` with
`get()`, `setApiKey(key)`, `deleteApiKey()`, `setDefaults(input)`, in
`AppServices` as `stripeSettings`. Same conventions as the other services
(one unit of work per operation, result objects with field codes).

- **Storage** in the key/value table `settings` (`STRIPE_SETTING_KEYS`):
  `stripe.apiKey` (plain text, #1), `stripe.defaultVatRate` (`VatRate`),
  `stripe.feeCategoryId`, `stripe.refundCategoryId` (ID as decimal text).
  Written by the import (#30): `stripe.lastImportAt` (`toISOString()` of the
  last successful import) and `stripe.lastImportTo` (latest imported range
  end `YYYY-MM-DD`, default range start in #31).
- **The key never reaches the UI:** `get()` returns
  `{ apiKey: { masked, mode } | null, defaults }` – masked as prefix plus the
  last four characters (`rk_live_…AbCd`), `mode` from the prefix
  (`live`/`test`). Only the import reads the full key with
  `loadStripeImportSettings(repos)` **in its own unit of work** (internal to
  business, not part of `AppServices`). If saving fails, `setApiKey` throws
  an error without a cause – Drizzle's message would contain the bound
  parameters, i.e. the key. The UI saves it without `useMutation` (TanStack
  Query would keep the variables in the cache), clears the field afterwards
  and does not log error details.
- **Key validation** (`validateStripeApiKey`, also used by the form):
  trimmed (`trimText`), then only restricted keys `rk_live_`/`rk_test_` with
  10–247 letters/digits. Codes: `required`, `secretKeyNotAllowed` (`sk_…`:
  full access to the Stripe account – the app deliberately only stores
  restricted read keys), `publishableKeyNotAllowed` (`pk_…`), `invalidKey`.
  Required permission: "Application fees: Read" (Connect; fee refunds are a
  sub-resource of application fees), optionally "Accounts: Read" (names of
  the connected accounts as counterparty), otherwise "None".
- **Defaults** (`setDefaults({ defaultVatRate, feeCategoryId,
  refundCategoryId })`, all three together; `validateStripeDefaults`, also
  usable against stored values): VAT rate a `VatRate` (`required`,
  `invalidVatRate`) – it only applies in **regularly taxed** years, there is
  no `null`; fee category exists, not archived, income and not a tax office
  category (USt-Erstattung, `categoryTaxOffice`); refund category exists,
  not archived, expense and "reduces income" (codes `required`,
  `categoryNotFound`, `categoryArchived`, `categoryTypeMismatch`,
  `categoryNotRevenueReduction`). Stored values that cannot be read (edited
  DB) count as not set.
- **Suggestions** (`suggestStripeDefaults(categories)`, never saved
  automatically; the form preselects them): fees → first non-archived income
  category on `BETRIEBSEINNAHMEN_UST_PFLICHTIG` ("Umsatzerlöse"), refunds →
  preferably the system income reduction ("Erlösminderung /
  Rückerstattung"), found via position and flag, **never by name**; VAT 19 %
  (platform fee to domestic connected accounts – the user confirms; other EU
  countries: reverse charge, non-EU: 0 %).
- **For the import (#30):** `loadStripeImportSettings(repos)` returns
  `{ ok: true, apiKey, defaultVatRate, feeCategory, refundCategory }`,
  `noApiKey` or `invalidDefaults` with codes – stored values are re-checked
  (category meanwhile archived, deleted, changed). The import books with the
  booking service's rules (`prepareBooking`), which enforce the year rule:
  in a **small business year** the import passes `vatRate: null`,
  regardless of the default rate.

## Stripe client (#29)

Port `StripeClient` (`src/business/stripe/stripe-client.ts`), implementation
`createStripeHttpClient()` in `src/app/stripe-http-client.ts` via `fetch`
from `tauri-plugin-http`; `createAppServices(database, clock, fileSaver,
stripeClient)` wires it up, tests pass a fake
(`src/business/__tests__/fake-stripe-client.ts`).

- **`listApplicationFees({ apiKey, createdFrom, createdTo })`** – all fees
  with `createdFrom ≤ created ≤ createdTo` (epoch seconds,
  `created[gte]`/`created[lte]`), newest first, `limit=100` and cursor
  `starting_after` while `has_more`. Each fee with **all** refunds: Stripe
  embeds the refund list; if it is truncated (`has_more`) or missing, the
  client fetches the rest via `GET /v1/application_fees/{id}/refunds` (also
  paginated). Result `{ ok: true, fees }` or `{ ok: false, error }` – all or
  nothing.
- **`getAccountName({ apiKey, accountId })`** – `GET /v1/accounts/{id}`, the
  connected account's name as counterparty of the imported bookings:
  `business_profile.name`, otherwise `settings.dashboard.display_name`,
  `company.name`, first and last name of `individual` (first non-empty,
  trimmed), `null` without a name. A response with a different `object`/`id`
  → `invalidResponse`. The import queries each account **once**, only for
  fees/refunds not yet booked; `permissionDenied` (optional permission
  "Accounts: Read" missing), 404 (account deleted) and `null` book the ID
  `acct_…`, other errors abort the import. Names over 200 characters are
  truncated.
- **Domain types:** fee `{ id ("fee_…"), amount (cents, ≥ 0), currency
  (lowercase, "eur"), created (epoch seconds UTC), account ("acct_…"),
  livemode, refunds }`, refund `{ id ("fr_…"), amount, currency, created }`.
  Every response is validated; deviations (no JSON, wrong type, wrong ID
  prefix, uppercase currency, `has_more` without data) → `invalidResponse`.
- **`verifyAccess({ apiKey })`** – one fee (`limit=1`), checks key and
  permission; `{ ok: true, livemode }` (`null` without fees). Used by
  `stripeSettings.testConnection()` ("Verbindung testen" in the settings):
  reads the key in a unit of work and calls Stripe **outside** of it;
  `noApiKey` or `{ reason: "stripe", error }`.
- **Error codes** (`StripeClientError`, UI texts in
  `src/ui/stripe/stripe-messages.ts`, `stripeClientErrorMessage`, also for
  #31): `invalidApiKey` (401), `permissionDenied` (403, e.g. missing
  permission "Application fees: Read"), `rateLimited` (429 after the
  retries, with `retryAfterSeconds` from `Retry-After` or `null`), `network`
  (unreachable, TLS, proxy, rejected by the HTTP scope), `timeout` (30 s per
  request), `stripeError` (other status, with Stripe's
  `error.code`/`error.message` or `null`), `invalidResponse`.
- **Retries:** up to three attempts per request on 429, on transient server
  errors (500/502/503/504) and on `network` (no response); it waits
  `Retry-After` (at most 10 s), otherwise 1 s, 2 s. Then `rateLimited`,
  `stripeError` or `network`. A rejection by the HTTP scope also arrives as
  `network` and is retried (only distinguishable by the message text).
  `timeout` is not retried (otherwise minutes of waiting). Everything is a
  GET – retrying is safe. `createdFrom > createdTo` is a programming error
  (`RangeError`).
- **Key:** only in the `Authorization: Bearer …` header, never in the URL;
  in no result, error or log (errors of plugin calls are reduced to codes,
  without the message). `Stripe-Version` is pinned (`STRIPE_API_VERSION`,
  `2026-10-28.endive`) – the validation is written against this version.
- **Tauri:** `tauri-plugin-http` (Rust, no cookie store). Capability
  `http:default` with a scope of **only**
  `https://api.stripe.com/v1/application_fees` (list),
  `https://api.stripe.com/v1/application_fees/*` (refunds sub-resource) and
  `https://api.stripe.com/v1/accounts/*` (account names; another host,
  another path like `/v1/application_feesX`, `http:` → rejected by the
  plugin). Query strings still match: the plugin sets a search missing from
  the pattern to `*` (`parse_url_pattern` in
  `tauri-plugin-http/src/scope.rs`). Redirects: the client sets
  `maxRedirections: 0`, and `plugins.http.scopeRedirects` in
  `tauri.conf.json` additionally checks every redirect target against the
  scope. Rust executes the request, the WebView only talks via IPC – **no
  CSP change** (`connect-src` stays at `'self' ipc: http://ipc.localhost`).

**Date (`src/business/stripe/stripe-dates.ts`):** `created` is an instant
(UTC). The booking date is the calendar day in **Europe/Berlin**
(`stripeCreatedToBookingDate`, via `Intl`, independent of the machine's time
zone): 31 Dec 23:30 UTC belongs to 1 Jan of the following year.
`bookingDateRangeToStripeCreated(from, to)` turns a range in calendar days
into the `created` range (00:00:00 of `from` to 23:59:59 of `to`, Berlin
time, also on days with 23/25 hours).

**Refunds and range – requirement for the import (#30):** Stripe has no list
of all fee refunds by date, only fees by `created` and refunds per fee.
Refunds get their **own** date (`refund.created`), not the fee's. So that a
refund in the range on an older fee is not missed, the import fetches fees
from `createdFrom − STRIPE_FEE_REFUND_LOOKBACK_DAYS` (180 days,
`subtractDays`) and then books

- fees with `created` in the range,
- refunds with `created` in the range (regardless of when their fee was
  created).

Refunds outside the range are left for a later import; the duplicate guard
via the external ID (`fee_…`/`fr_…`) prevents duplicates. **Known limit:** a
refund on a fee created more than 180 days before the range is not found
(rare in practice – refunds follow the refund of the payment). More lookback
only costs requests (100 fees per page).

## Stripe import (#30)

`src/business/stripe/stripe-import-service.ts` –
`createStripeImportService({ unitOfWork, stripeClient, clock })` with
`import({ from, to })` and `getStatus()`, in `AppServices` as
`stripeImport`.

- **Flow:** (1) unit of work: `loadStripeImportSettings`. (2) **Outside** any
  unit of work: `listApplicationFees` from `from − 180 days` to the end of
  `to` (see [Stripe client](#stripe-client-29)). (3) Select fees and refunds
  with their **own** `created` in the range, oldest first (fee before its
  refund), IDs listed twice only once. (4) **One** unit of work: load the
  settings again (may have changed during the request → possibly
  `noApiKey`/`invalidDefaults`), skip existing external IDs (source
  `stripe`, `findExistingExternalIds` in one query), validate and create the
  rest, write `stripe.lastImportAt`/`lastImportTo`. An unexpected error rolls
  everything back (no booking, no timestamp) and is thrown. If the API key
  was replaced during the request, the import books nothing and returns
  `{ ok: false, reason: "settingsChanged" }` (the fees may belong to another
  account) – import again.
- **Lookback limit:** refunds on fees created **more than 180 days before
  `from`** are **never** seen by the import – even if the refund itself is in
  the range (Stripe lists refunds only per fee, and the fee is outside the
  queried range). Such refunds must be booked manually.
- **Range:** `from`/`to` inclusive calendar days (Europe/Berlin). Codes
  `required`, `invalidDate`, `beforeFrom` (`to` before `from`), `inFuture`
  (`to` after today – it would become the start of the next import).
- **Mapping:**

  | Field        | Fee                                      | Refund                                    |
  | ------------ | ---------------------------------------- | ----------------------------------------- |
  | Date         | `fee.created` (Berlin)                   | `refund.created` (Berlin)                 |
  | Type         | Income                                   | Expense                                   |
  | Gross        | `amount`                                 | `amount`                                  |
  | VAT rate     | default; `null` in a small business year | default; `null` in a small business year  |
  | Category     | fee category                             | refund category (reduces income)          |
  | Description  | "Stripe Application Fee"                 | "Stripe Application Fee – Rückerstattung" |
  | Counterparty | account name, otherwise `acct_…`         | like the fee                              |
  | Reference    | –                                        | `fee_…` of the refunded fee               |
  | Note         | –                                        | –                                         |
  | Source / ID  | `stripe` / `fee_…`                       | `stripe` / `fr_…`                         |

  The descriptions are stored domain values (like the names of the default
  categories), not UI texts: `STRIPE_BOOKING_DESCRIPTIONS`, editable like
  any booking.

- **One source of rules:** the booking service exports
  `prepareBooking(input, lookups, existing?)` (validation, normalisation,
  `calculateBookingAmounts`). `create`/`update` pass
  `repositoryBookingLookups(repos)`; the import passes lookups over data it
  loads once per run in its unit of work (categories, tax years, existing
  IDs) – no nested `run`, no queries per booking except the insert.
- **Result:** `{ ok: true, range, keyMode, created, skipped, failed, fees,
  refunds }` (`fees`/`refunds` each `{ created, skipped, failed }`; `failed`
  per entry `{ kind, externalId, date, amount, currency, code, errors? }`)
  or `{ ok: false, reason: "invalid" | "noApiKey" | "invalidDefaults" |
  "settingsChanged" | "stripe" }`. Error codes per entry:
  `unsupportedCurrency` (not EUR), `zeroAmount`, `amountTooLarge` (above
  `MAX_AMOUNT_CENTS`), `invalidBooking` (with the booking service's field
  errors). Failed entries are not booked; a later import tries them again.
  **Skipped** means: the external ID already exists (deleted bookings are
  created again, #1); manual bookings with the same ID do not count.
- **Last import:** only on `ok: true` (also with failed entries), in the same
  transaction. `lastImportAt` = time of the run; `lastImportTo` = the later
  of the previous value and `to` (importing an older range does not reset
  it). `getStatus()` returns `{ lastImportAt, lastImportTo }` (`null` if
  never/unreadable). **#31:** default range `lastImportTo` to today – the
  same day again, because fees created later that day would otherwise be
  missing; duplicates are skipped. Without a previous import, #31 decides
  (e.g. 1 January of the year).

## EÜR positions (#13)

`src/business/euer` contains the stable EÜR positions, the line mapping per
tax year (`describePosition(position, year)`), the redirection in a small
business year (`positionForTaxStatus`) and the validation of a category's
position (`validateCategoryPosition`). The migration
`0001_default_categories` creates the default categories. Details, sources
and the procedure for a new tax year:
[Data model](data-model.md#eür-positions-13).

## EÜR service (#25)

`src/business/euer` – `createEuerService({ unitOfWork })` with
`calculate(year)`, in `AppServices` as `euer`. One unit of work reads the
tax status (regularly taxed without a record, #16), all categories
(including archived ones) and `BookingRepository.sumByCategoryAndVatRate(year)`;
the calculation itself is the pure function `calculateEuer`. Result
`{ ok: true, euer }` or `invalidYear` (without database access). Rules,
decisions and result shape:
[Data model](data-model.md#eür-calculation-25).

## App shell & routes

| Route                  | Area                                                       |
| ---------------------- | ---------------------------------------------------------- |
| `/`                    | Redirect to `/bookings` (start page)                       |
| `/bookings`            | Booking list; filter/sort/page as search params (#22, #23) |
| `/bookings/$bookingId` | Edit booking (form, #18)                                   |
| `/bookings/new`        | New booking (form, #18)                                    |
| `/euer`                | EÜR annual view; year as search param `year` (#26)         |
| `/categories`          | Category management                                        |
| `/settings`            | Settings (tax years, Stripe, backup, updates)              |
| anything else          | `notFoundComponent` of the root route, inside the shell    |

- **Paths are English** (#76); the UI language is German, code identifiers
  are English (`BookingsPage`, `bookings_title`).
- `/` redirects instead of rendering the bookings itself: that way there is
  exactly one URL for the list including search params, and the navigation
  marks it unambiguously as active.
- The layout (`src/ui/layout/app-shell.tsx`) renders the root route around
  the `<Outlet />` in the style of a Windows 11 app (Fluent, top
  navigation): at the top a bar in the sidebar colour (logo, main
  navigation, update notice, settings; the active entry has a short accent
  stroke), below it, flush with `border-t`, the content area. The font is
  Segoe UI Variable; controls have a 4 px radius (`rounded-lg`/`-md`),
  layers like cards, dialogs and popups 8 px (`rounded-xl` and larger, see
  `src/ui/styles/globals.css`). Pages use `Page` from
  `src/ui/layout/page.tsx`: no visible page title (the `h1` is `sr-only`,
  the navigation shows the location), `actions` right-aligned above the
  content, full width; forms limit their own width. `fill` for pages with
  their own scroll area, `compact` for narrow margins (the booking list puts
  filters and actions in one bar), `stretch` for pages that fill at least
  the window height – the booking form thus has a fixed command bar at the
  bottom (`#app-content` keeps focused fields above it with `scroll-pb-20`).
  Pages set the document title via `head` (`m.page_title({ page })`).
- The content area (`#app-content`) scrolls, not the window; the router
  resets it on navigation (`scrollToTopSelectors`). A skip link jumps there.
- Tests are not treated as routes: `routeFileIgnorePattern` in
  `vite.config.ts` excludes `*.test.ts[x]` and `__tests__/` in `src/routes`.

### App startup (composition root)

`src/routes/__root.tsx` wraps the shell in `AppServicesProvider`
(`src/app/app-services.tsx`). It calls `startApp()` (`src/app/startup.ts`)
once in an effect: open the database, apply pending migrations
([Data model](data-model.md)), create unit of work and services
(`createAppServices`, `src/app/services.ts`). `AppServices` contains only
services (`bookings`, `bookingExport`, `categories`, `taxYears`, `euer`,
`euerExport`, `stripeSettings`, `stripeImport`, `backup`, `updates`), no
repositories and no unit of work: UI and routes always go through the
services. Until then it shows a loading screen, afterwards the app;
components get the services with `useAppServices()`.

- **WebView only:** startup runs in the effect. When pre-rendering the SPA
  shell (Node) there is no Tauri; the shell contains the loading screen.
- **Errors** are shown on a German error screen
  (`src/ui/layout/startup-screen.tsx`) with the technical details (error
  including the `cause` chain) and "Erneut versuchen" (reloads the page).
- **Database not opened:** if the host cannot open the file
  (`src-tauri/src/lib.rs`), it only logs the cause; every query then fails
  with "database sqlite:belegwerk.db not loaded". The error screen detects
  this (`isDatabaseNotLoaded`) and points to the log in
  `%LOCALAPPDATA%\de.belegwerk.desktop\logs` (default target `LogDir` of
  `tauri-plugin-log`, Tauri `app_log_dir`).
- **Browser without Tauri** (`pnpm dev` directly in the browser): there is
  no database; the error screen says to start the app with
  `pnpm tauri dev`.
- Services are not passed to loaders as router context (they only exist
  after startup in the provider); the booking pages load via `useQuery` in
  the component.

### TanStack Query

`src/app/query-client.ts` creates the `QueryClient` (composition root:
defaults like `retry: false` are app configuration, not a UI detail).
`src/router.tsx` creates one client per router instance, provides it via
`Wrap` with `QueryClientProvider` and passes it to loaders as router context
(`context.queryClient`).

**Query keys** live per area with the hooks in `src/ui/<area>/*-queries.ts`,
e.g. `bookingQueryKeys` in `src/ui/bookings/booking-queries.ts`:
`["bookings"]` (everything), `["bookings", "list", query]` (search with its
`BookingQuery`, #21; prefix `bookingQueryKeys.lists()`),
`["bookings", "detail", id]` (only for integer IDs; `NaN` would give the
shared key `[…, null]`) and `["bookings", "suggestions", field, type]` (the
form's text suggestions, `useBookingTextSuggestions`; under `all`, so
refreshed after every booking change and every Stripe import). Likewise
`categoryQueryKeys` (`src/ui/categories/category-queries.ts`,
`useCategoryList()`), `taxYearQueryKeys`
(`src/ui/tax-years/tax-year-queries.ts`, `useTaxYear(year)`,
`useTaxYearList()`), `euerQueryKeys` (`src/ui/euer/euer-queries.ts`,
`useEuer(year)`, #26), `stripeQueryKeys` (`src/ui/stripe/stripe-queries.ts`,
`useStripeSettings()`, #28; only the masked key in the cache) and
`stripeImportQueryKeys` (same file, `useStripeImportStatus()`, #31).
Booking mutations (`useBookingMutations()`, #18) invalidate
`bookingQueryKeys.all`, `categoryQueryKeys.all` (`bookingCount`),
`taxYearQueryKeys.all` (`list()` contains years with bookings) and
`euerQueryKeys.all`. Category and tax year mutations also invalidate
`euerQueryKeys.all` (position/flag and tax status apply retroactively to
the EÜR). If the form then leaves the page (success, "not found"), only
inactive queries are refetched – otherwise the edit page would briefly show
a just-deleted booking as "not found".

### Booking list (#17)

- `src/routes/bookings.index.tsx` (`/bookings`) loads with
  `useBookingList(query)` and shows loading, error (with "Erneut versuchen")
  and empty states. Filters (#22), sort, page and page size (#23) come from
  the URL parameters.
- `src/ui/bookings/booking-table.tsx` renders the rows with TanStack Table
  (v9: `useTable`, `tableFeatures`, `columnMeta` for column classes), without
  its own sorting/pagination – the search does that in SQL (#21, #23).
- **Type** as text with an arrow icon and colour, gross in the type's colour
  (never colour alone). Amounts right-aligned with `tabular-nums` and
  `formatCurrency`, date with `formatDate`. Archived categories are marked.
  Long texts are truncated (full text in `title`) so the table fits the
  default window (1280 px).
- **Editing:** clicking the row navigates to `/bookings/$bookingId`; for the
  keyboard the description is a link (Tab, Enter). Clicks on the link and
  clicks with a modifier (Ctrl/Shift/Alt/Meta) do not trigger row
  navigation. The route parses the ID to a number (otherwise `NaN` → "not
  found" without a query) and shows an unknown booking on the page, without
  `notFound()` – the root route detects the 404 title via `_notFound`, which
  only applies to unknown paths.

### Filters and search (#22)

Search field and filter bar (`src/ui/bookings/booking-filter-bar.tsx`) above
the list, on the left of the toolbar (it wraps early, the "+" and "…" actions
stay on the right of the first row): next to the search field, "Filter"
(with the number of active filters) opens a popover with the filters that
are not set; set filters sit in the bar itself, each with an × that removes
it. While the popover is open, its filters stay in it (a filter set there
does not jump away from under the pointer or cursor) and move to the bar on
close. The select labels are for screen readers only, the trigger names the
filter itself ("Art: Alle") and is highlighted while the filter is active.
The pure logic – URL schema, mapping to `BookingQuery`, quick-pick periods,
category options – lives tested in `booking-filter-model.ts`.

**URL schema** (`validateSearch: validateBookingSearch`, all parameters
optional; default values never appear in the URL):

| Parameter                | Value                                                  | `BookingQuery`           |
| ------------------------ | ------------------------------------------------------ | ------------------------ |
| `q`                      | Search text (trimmed)                                  | `text`                   |
| `from`, `to`             | Payment date `YYYY-MM-DD`, inclusive                   | `dateFrom`, `dateTo`     |
| `type`                   | `income` or `expense`                                  | `type`                   |
| `category`               | Category IDs (array, e.g. `[1,7]`)                     | `categoryIds`            |
| `source`                 | `manual` or `stripe`                                   | `source`                 |
| `vat`                    | VAT rates (array of `none`, `0`, `7`, `19`, `rc`; #26) | `vatRates`               |
| `amountFrom`, `amountTo` | Gross in **cents**                                     | `amountFrom`, `amountTo` |
| `sort`                   | `<column>-<asc\|desc>` (#23)                           | `sort`                   |
| `page`                   | Page from 2 (#23)                                      | `page`                   |
| `pageSize`               | 25, 100 or 200 (default 50 is not in the URL; #23)     | `pageSize`               |

- **Serialisation:** TanStack Router's default (values as JSON where
  needed). Strings that look like JSON are quoted (`?q=2025` becomes
  `?q="2025"`); arrays appear as `category=[1,7]`. Amounts as cents and dates
  as ISO keep the URL independent of the display format.
- **Invalid parameters** never cause an error: unreadable values (unknown
  type/source, impossible date, no cent amount 0 to `MAX_AMOUNT_CENTS`, no
  ID) are discarded, and the router writes back the cleaned URL. Readable but
  contradictory values (`to` before `from`, `amountTo` < `amountFrom`,
  control characters or too long search text) stay; `normalizeBookingQuery`
  reports them, the filter bar shows the error at the field, and the list a
  hint instead of results (no query).
- **Router caveat:** a route's search is layered over its parent's, and the
  root route keeps the raw parameters. `validateBookingSearch` therefore
  returns every key of the schema, discarded ones as `undefined` – otherwise
  e.g. `type=foo` would shine through. Unknown parameters shine through, are
  ignored and removed on the next filter change.
- **Period:** only `from`/`to` are stored; the quick pick (year, quarter,
  month) is derived from them (`detectPeriod`) when it matches exactly – so a
  URL has exactly one meaning, while an extra `period` parameter could
  contradict the dates. "Frei" (two date fields) stays selected while in use,
  even if the dates happen to form a whole month – until another quick pick
  is chosen, it is reset or the period changes from outside (back/forward).
  Years to choose from: tax years and years with bookings
  (`useTaxYearList`), the current and the selected one.
- **History:** selections (period, type, categories, source, reset) create
  an entry, back/forward restores them. Typed values (search text debounced
  300 ms, amounts/free dates 500 ms; Enter/blur immediately) create an entry
  when set or cleared and replace it while typing on – so not every
  keystroke ends up in the history. If the URL changes from outside (back,
  reset), the fields take the value and discard pending input
  (`useDebouncedInput`).
- **Type and categories:** the multi-select (Base UI `Select multiple`)
  groups by type, archived ones marked; with a type filter only that type's
  categories. Selected categories of the other type and IDs without a
  category (from a URL) appear marked in the list so they can be deselected.
  Changing the type removes categories of the other type.
- **VAT rate** (#26): multi-select "Ohne USt-Satz", 0 %, 7 %, 19 %, reverse
  charge. Mainly meant for the EÜR's drill-down links (line 15 = 7 % and
  19 %); that way you see and can change the filter. In the URL sorted and
  without duplicates (`vat=["0","19"]`; numbers like `vat=[19]` are read
  too), unknown values are discarded. SQL: `vat_rate IN (…)`, for "none"
  additionally `OR vat_rate IS NULL`.
- **Amounts** with a decimal comma (`parseAmount`); unreadable input shows an
  error and does not change the URL.
- **Result:** "N Buchungen gefunden" (`role="status"`); with filters and no
  hits "Keine Buchungen passen zu den Filtern" plus "Filter zurücksetzen",
  without filters still "Noch keine Buchungen". While a new search loads, the
  old result stays dimmed (only a successful one, `placeholderData`); an
  invalid filter does not query (`enabled: false`).
- **Reset** clears all filters (only visible when one is active; "N Filter
  aktiv" is announced), rebuilds the filter bar and focuses the search
  field.
- **Reset** keeps sort and page size (#23), the page goes to 1.

### Sorting, pages and sums (#23)

- **`sort`:** column and direction in one parameter so a URL has only one
  meaning: `date`, `type`, `description`, `counterparty`, `category`, `net`,
  `vat`, `gross`, `source` (each a `BOOKING_SORT_FIELDS`), plus `-asc`
  (ascending) or `-desc` (descending), e.g. `?sort=gross-asc`. The default
  `date-desc` is not in the URL. Mapping in `booking-filter-model.ts`
  (`sortParam`, `parseSortParam`, `sortSearchParam`, `bookingSearchSort`).
- **`page`** from 1 (page 1 not in the URL), **`pageSize`** from
  `BOOKING_PAGE_SIZES` (25/50/100/200; 100 not in the URL). Other values are
  discarded like the filters. `bookingSearchToListQuery` builds the list's
  query from them.
- **Page back to 1:** `updateBookingSearch` removes `page` as soon as
  anything else changes – filter, sort or page size – unless the patch sets
  `page` itself. Page and sort changes each create a history entry.
- **Page past the last one** (old link, last booking of a page deleted): the
  search returns the last page (#21); the list aligns `page` with the
  delivered one via `replace` (back does not lead to the empty page). Only
  for a fresh result (never placeholder data, never a cached one that is
  refetching) – the next result has the requested page, so there is no loop.
- **Column headers** are buttons (Tab, Enter/Space): the sorted column flips
  direction, another one starts with its initial direction
  (`initialSortDirection`: date and amounts descending, texts, type and
  source ascending). The sorted column has `aria-sort` and an arrow, the
  tooltip names the action ("Nach Brutto aufsteigend sortieren"), the
  caption the current sort. No TanStack sorting: the rows come sorted from
  SQL.
- **Scrolling:** the table scrolls in its own box, the column header stays
  at the top (`sticky`); sums and pagination are fixed in the box's footer.
- **Pagination** (`booking-pagination.tsx`, `<nav>`) on the right of the
  footer, single line: "101–192 von 192", page size ("100 pro Seite"),
  previous/next (icons with `aria-label`, disabled at the edges but
  focusable – focus stays on the last page) around "Seite X von Y"
  (`aria-live`).
- **Sums** (`BookingSumsSummary`) on the left of the footer: income,
  expenses, balance (gross) of the **entire** filtered set (`sums`); the
  group name says "not just this page". The balance has a sign and a word
  ("Überschuss"/"Fehlbetrag"), not only colour. The hit count ("N Buchungen
  gefunden") is a `role="status"` for screen readers only; visibly it is in
  the pagination ("1–50 von 120").
- **CSV export (#24):** `bookingSearchToQuery(search)` plus
  `sort: bookingSearchSort(search)` and `pageSize: "all"` – the same filter
  and sort as the list, all pages (see [CSV export](#csv-export-24)).

### CSV export (#24)

"CSV exportieren" in the booking list's "…" menu (`useBookingExportAction`
in `src/ui/bookings/booking-export-button.tsx`) saves **all** bookings of the
current filters in the list's sort order, not just the page.

**CSV format** (`src/business/csv`, `toCsv(rows)`; applies to all exports,
including the EÜR #27):

| Point              | Definition                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Separator          | `;` (Excel's list separator in de-DE)                                                                                   |
| Line ending        | CRLF after **every** line, including the last (RFC 4180, Excel on Windows)                                              |
| Encoding           | UTF-8 with BOM: `toCsv` puts U+FEFF at the start (in exactly one place); written as `EF BB BF`                          |
| Quoting            | Fields with `;`, `"`, CR or LF in `"…"`, inner `"` doubled; otherwise unchanged                                         |
| Date               | `TT.MM.JJJJ` (`formatDate`)                                                                                             |
| Amounts            | `formatAmountPlain`: decimal comma, no thousands separator, no `€`, ASCII minus (`1234,56`, `-0,05`)                    |
| Empty fields       | `null` → empty field (e.g. VAT rate in a small business year, reference/note/external ID)                               |
| Formula protection | Text that starts (also after whitespace) with `=`, `+`, `-`, `@` or with Tab/CR gets a `'` prefix (OWASP CSV injection) |

- **Formula protection only for texts:** cells are `string` (user or label
  text, protected), `csvLiteral(…)` (formatted by the app: amounts, dates –
  unchanged, so e.g. a negative EÜR balance stays a number) or `null`. The
  protection changes the visible value (`'-Rabatt`); this only affects texts
  that start that way and is the usual trade-off.
- **Columns** (`BOOKING_CSV_COLUMNS`, `bookingsToCsv(items, labels)` in
  `src/business/bookings/booking-csv.ts`): Datum, Art, Beschreibung,
  Gegenpartei, Kategorie, Netto, USt-Satz, USt, Brutto, Referenz, Notiz,
  Quelle, Externe ID. Header and value labels (Einnahme/Ausgabe, VAT rates,
  Manuell/Stripe) are UI texts: the UI passes them (`bookingCsvLabels()` in
  `booking-messages.ts`), business stays free of Paraglide and testable.
- **File name** (`csvFileName`): by the filter's period,
  `buchungen-2025-01-01_2025-12-31.csv`, open-ended
  `buchungen-ab-2025-01-01.csv` or `buchungen-bis-….csv`, without a period
  the export date `buchungen-2026-11-14.csv`. Words from Paraglide;
  characters forbidden on Windows become `_`. Dialog filter "CSV-Datei"
  (`*.csv`).
- **Service** `createBookingExportService({ bookings, fileSaver })`,
  `exportCsv({ query, labels, fileName, filterName })`: loads via
  `BookingService.list({ ...query, page: 1, pageSize: "all" })` (before the
  dialog – invalid filters never open it), builds the file and saves it via
  the `FileSaver`. Result `{ ok: true, saved: true, fileName, count }`,
  `{ ok: true, saved: false }` (cancel) or `{ ok: false, reason: "invalid",
  errors }`; load/write errors throw. No upper limit: the data of a local
  EÜR app fits in memory.
- **Button:** disabled (focusable, reason in the tooltip) while the filters
  are invalid, nothing is loaded, nothing matches or an export is running
  (then with a spinner and "Exportiere …"). The count comes from the same
  list query as the table (same query key), never from placeholder data of
  the previous search. Success: toast with count and file name; dialog
  cancelled: no toast; error (e.g. file open in Excel): error toast, details
  in the console.

### EÜR annual view (#26)

`src/routes/euer.tsx` (`/euer`) shows `services.euer.calculate(year)` (#25)
for the year from the search param `year` (1000–9999; default: current
calendar year, then not in the URL; invalid values are discarded). Pure
logic (URL, table rows, drill-down and warning links) lives tested in
`src/ui/euer/euer-model.ts`, the presentation in `euer-view.tsx`.

- **Year picker** in the page header: tax years and years with bookings
  (`useTaxYearList`), the current and the selected year
  (`periodYearOptions`). Below it the year's tax status (regular taxation /
  small business) with a link to the settings.
- **Tables** Betriebseinnahmen and Betriebsausgaben: line, label (official
  from `describePosition`, without mapping the position's display name),
  amount (`formatCurrency`, right-aligned, `tabular-nums`), each with a
  total row. Line 13 (informational) follows line 12, indented, with
  "nachrichtlich" and the amount in parentheses; it does not count towards
  the total. Entertainment shows total, "nicht abziehbar" and "abziehbar"
  below the label; the line's amount is the deductible part.
- **Result:** total income, total expenses and profit or loss with a word
  and sign, not only colour.
- **Without a line mapping** for the year: hint "Für {Jahr} gibt es noch
  kein Zeilen-Mapping; angezeigt werden nur die Positionen.", line "–".
- **Warnings** (`EuerWarning`) as a list with text (Paraglide) and, where
  the filter can express them, "Betroffene Buchungen anzeigen": VAT rate in
  a small business year (`vat` = all rates), missing rate in a regularly
  taxed year (`vat=["none"]`), rate 7/19 % on payments to / from the tax
  office (their categories + `vat` 7/19), unassignable bookings (their
  categories – may also include counted bookings of the other type),
  negative line, entertainment and additional meal expenses (the line). The
  count in the warning only counts assignable bookings; the linked list may
  also contain unassignable bookings (the filter cannot exclude them), so it
  can be longer.
- **Drill-down:** the label of every position is a link to `/bookings` with
  `from`/`to` = year, `category` = all contributing categories, `vat` =
  union of the contributing rates (omitted when all five contribute) and
  `type` only if all contributions have the same type. The filter combines
  with AND, so it cannot express "(A and income) or (B and expense)" – the
  union is still exact: within the same year, a category's bookings with the
  same rate always land in the same line (tax status per year; 15/16 and the
  VAT lines by rate, all other lines with all rates of their categories),
  and categories have a fixed type. Mixed lines (turnover categories plus
  their income reduction) therefore get no type filter. The only deviation:
  bookings whose type does not match the category (do not count in the EÜR,
  cannot be created via the services). The list's count matches the line's
  booking count; the list's sums are gross, while the EÜR computes net in a
  regularly taxed year (line 15 + line 17 = the list's gross when no income
  reduction contributes).
- **States:** loading, error with "Erneut versuchen", empty year ("Für
  {Jahr} gibt es keine Buchungen."). A year without lines but with warnings
  (e.g. only unassignable bookings) shows the warnings and "Für {Jahr} gibt
  es keine Positionen in der EÜR."
- **Accessibility:** missing line number visibly "–" (`aria-hidden`) plus
  `sr-only` "ohne Zeile"; a position's booking count is in the tooltip and,
  via `aria-describedby` (hidden element, not read twice), the link's
  description.

### CSV export of the EÜR (#27)

"CSV exportieren" next to the year picker
(`src/ui/euer/euer-export-button.tsx`) saves the EÜR of the shown year – the
same CSV format as the booking export (see [CSV export](#csv-export-24):
`toCsv`, `;`, CRLF, UTF-8 with BOM, amounts via `formatAmountPlain` as
`csvLiteral`).

**Structure** (`euerToCsv(result, labels)` in `src/business/euer/euer-csv.ts`,
pure): header row, one row per position, the totals at the end.

```csv
Bereich;Zeile;Bezeichnung;Betrag;Nicht abziehbar
Betriebseinnahmen;15;Umsatzsteuerpflichtige Betriebseinnahmen (…);1000,00;
Betriebseinnahmen;17;Vereinnahmte Umsatzsteuer sowie (…);190,00;
Betriebsausgaben;58;Gezahlte und nach § 15 UStG abziehbare Vorsteuerbeträge;19,00;
Betriebsausgaben;64;Bewirtungsaufwendungen;70,00;30,00
Ergebnis;;Summe Betriebseinnahmen;1190,00;
Ergebnis;;Summe Betriebsausgaben;89,00;
Ergebnis;;Gewinn;1101,00;
```

- **Bereich** separates the blocks so a spreadsheet can filter or sum by it:
  Betriebseinnahmen, Betriebseinnahmen (nachrichtlich), Betriebsausgaben,
  Ergebnis. The sum of `Betrag` over "Betriebseinnahmen" gives the total
  income – line 13 has its own area and does not count twice, the totals are
  under "Ergebnis".
- **Order** as in the view: income by line, line 13 directly after line 12
  (`incomeInReportOrder`, shared with `euerTables`), then expenses, then
  Summe Betriebseinnahmen, Summe Betriebsausgaben and Gewinn / Verlust /
  "Weder Gewinn noch Verlust" (with sign; a loss is a negative number).
- **Zeile** empty without a line mapping; **Bezeichnung** = the year's
  official text, otherwise the position's display name.
- **Entertainment:** `Betrag` = deductible part (70 %, counts in the total),
  `Nicht abziehbar` = 30 % – the form's two columns; only this row fills the
  fifth column. Total = Betrag + Nicht abziehbar. A separate column instead
  of "of which" rows so the sum over `Betrag` is correct.
- **Year and tax status** are not in the file (no meta block before the
  header – the file stays a simple table): the year is in the file name, the
  status follows from the lines (12 or 15/16).
- **Texts** (header, areas, totals, display names) are passed by the UI
  (`euerCsvLabels()` in `src/ui/euer/euer-messages.ts`); the official labels
  come from the result as form data.
- **File name** `yearCsvFileName(base, year)`: `euer-2025.csv` (`euer` from
  Paraglide). Dialog filter as for the booking export.
- **Service** `createEuerExportService({ euer, fileSaver })`
  (`AppServices.euerExport`), `exportCsv({ year, labels, fileNameBase,
  filterName })`: calculates before the dialog (`EuerService.calculate`),
  saves via the `FileSaver`. Result `{ ok: true, saved: true, fileName,
  year }`, `{ ok: true, saved: false }` (cancel) or `{ ok: false, reason:
  "invalid", errors }` (invalid year, no dialog); calculation/write errors
  throw. No new capabilities.
- **Button:** disabled (focusable, reason in the tooltip) while the EÜR is
  loading or could not be calculated, for a year without lines (nothing to
  export) and while an export is running (spinner, "Exportiere …"). The data
  comes from the same query as the table (same query key). Success: toast
  "EÜR {Jahr} in {Datei}"; cancel: no toast; error: error toast, details in
  the console.

### Booking form (#18)

`src/ui/bookings/booking-form.tsx` (TanStack Form) serves `/bookings/new`
and `/bookings/$bookingId`; the pure logic (values, conversion to
`BookingFormInput`, client checks, preview, category options) lives tested
in `booking-form-model.ts`, the texts for error codes in
`booking-messages.ts`.

- **Values are strings;** on submit they become `BookingFormInput`. Source
  and external ID are never sent (`update` keeps them); imported bookings
  show them for information only, as a one-line info bar at the top of the
  form ("Importiert aus Stripe · Externe ID …").
- **Layout:** one field per row, the label above it (type, date,
  description, counterparty, category, gross amount, VAT rate, reference,
  note); date, amount and VAT rate are narrow (`max-w-50`/`w-50`). The
  command bar is fixed at the bottom: cancel and (when editing) delete as a
  red button on the left, save on the right.
- **Keyboard:** Ctrl+S saves (also without focus in the form, not with an
  open dialog), Esc cancels – unless Esc first closes something (suggestion
  list with `aria-expanded`, a popup). The buttons' tooltips name the keys.
- **Validation:** the service is authoritative. The form only pre-checks
  what it knows itself (required fields, amount text via `parseAmount`,
  amount greater than 0) – on submit, then on every change
  (`revalidateKeepingServerErrorsOnBlur` in
  `src/ui/forms/validation-logic.ts`: `revalidateLogic()`, but leaving a
  field does not clear service errors). Service errors are set per field as
  `errorMap.onServer` and stay until the value changes or the form is
  submitted again. Form-core only clears them for fields with `validators`;
  fields without a client check (type, reference, note) therefore have a
  no-op validator (`noValidation`). Errors on source/external ID appear above
  the buttons. After a failed submit the first invalid field gets focus (in a
  small business year possibly the hint instead of the VAT field); error
  texts are attached to the field via `aria-describedby`.
- **Date:** native `<input type="date">` (returns ISO; WebView2 shows the
  system format, e.g. `TT.MM.JJJJ`, including a calendar). New bookings start
  with today, expense and 19 %.
- **Amount:** text field with a decimal comma; on blur a valid amount is
  normalised (`1.500` → `1.500,00`, the dot is the thousands separator).
- **VAT rate** only in a regularly taxed year of the date (`useTaxYear`);
  with an incomplete date the year counts as regularly taxed. In a small
  business year a hint appears instead, and `null` is sent. The pages load
  the status of the initial date before the form (no flicker).
- **Preview** "Netto … · USt …" live with `calculateBookingAmounts`, small
  next to the VAT rate (the gross amount is the input field itself); while
  the amount or rate is invalid, a hint is shown there. In a small business
  year (no VAT rate) it is omitted.
- **Tax office VAT categories:** if the user picks a category with
  `UST_AN_FA` or `UST_ERSTATTUNG` (`isTaxOfficePayment`), the form sets the
  VAT rate to `0` and (regularly taxed) shows a hint; the rate stays
  editable, the service validates as before. The EÜR counts such bookings
  gross anyway (#25).
- **Category:** only categories of the type, without archived ones – except
  the edited booking's previous category and the currently selected one (if
  it is archived meanwhile, it stays visible and marked, and the service
  reports `categoryArchived`). If the type changes, a non-matching category
  is cleared.
- **Description and counterparty** suggest previous values
  (`BookingTextInput`, `suggestTexts` with the form's type): free text stays
  possible, the suggestions only help. Filtering happens while typing in
  `filterTextSuggestions` (case-insensitive substring, umlauts and
  decomposed input included; matches at word/text start first; at most 50
  visible; a suggestion equal to the input is omitted). The list only opens
  when something matches (while typing or with arrow down) – no "no
  suggestions" popup for every new text. Arrow keys select, Enter accepts
  (without submitting), Escape closes the list and never changes the text
  (Base UI 1.9.0 clears the field with reason `escape-key` when the list is
  closed – `BookingTextInput` ignores that change), Tab leaves the field and
  closes the list; without a highlighted suggestion Enter submits the form.
  The form does not wait for the suggestions; the comparison keys
  (`prepareTextSuggestions`) are computed once per loaded list.
  **Component:** Base UI Autocomplete (`src/ui/components/ui/autocomplete.tsx`,
  styled like shadcn's `combobox`; base-nova in shadcn 4.23.0 has no
  `autocomplete`) instead of `<datalist>`: consistent look, own filter logic
  (umlauts, order), `aria-activedescendant`, and the props of `FormField`
  (`id`, `aria-invalid`, `aria-describedby`) land unchanged on the input.
  Combobox does not fit – it picks from a fixed set instead of free text.
- **After saving/deleting** back to the list with a toast; "not found"
  likewise, with a hint. Deleting asks in an alert dialog (focus on
  "Abbrechen", Escape closes).

### Category management (#19)

`src/routes/categories.tsx` (`/categories`) loads with `useCategoryList()`
and renders `src/ui/categories/category-list.tsx`. Pure logic (grouping,
position options, form values, client checks) lives tested in
`category-model.ts`, the texts for error codes and the position display in
`category-messages.ts`, the mutations in `category-mutations.ts`.

- **List:** one table each for income and expenses, sorted by name. EÜR
  position as "Zeile N · display name" for the **current calendar year**
  (`describePosition`; without mapping only the display name, the official
  label in `title`). Markers "mindert Einnahmen", "System", "archiviert";
  bookings column (`bookingCount`).
- **Archived** ones are hidden by default; "Archivierte Kategorien anzeigen
  (n)" shows them dimmed at the end of their group.
- **Create/edit** in a dialog (`category-form.tsx`, same validation patterns
  as the booking form; `FormField`, `focusFirstInvalid` and `fieldErrors`
  live together in `src/ui/forms/form-field.tsx`). The type is only chosen
  when creating. "Mindert Einnahmen" only exists for expenses. The position
  picker (`positionOptions`) is exactly the set that
  `validateCategoryPosition` accepts for type and flag (income reduction:
  only the turnover positions 15/16); if type or flag change, a
  non-matching position is cleared. For system categories, position and flag
  are locked (only the name is sent). If the category has bookings, the form
  points out that a position change applies retroactively.
- **Archive/reactivate** immediately with a toast (reversible, no
  confirmation); not for system categories.
- **Delete** only with `bookingCount === 0` and not system (otherwise
  disabled, hint in `title`), with an alert dialog (focus on "Abbrechen").
  If the service still reports `inUse`/`systemCategory` (race), a toast
  appears suggesting to archive instead.
- **Invalidation:** category mutations invalidate `categoryQueryKeys.all`
  and `bookingQueryKeys.all` (the booking list shows the category name and
  "archiviert"; the booking form gets its options from the category list).

### Settings (#20)

`src/routes/settings.tsx` (`/settings`) stacks sections (`SettingsSection`
from `src/ui/settings/settings-section.tsx`: `<section>` with heading and
description via `aria-labelledby`/`aria-describedby`). Each section loads
its own data and shows its own loading/error states; the "Stripe" section
(#28) follows as another `SettingsSection` below, then "Datensicherung"
([#32](#backup-32)) and "Updates" ([#71](#auto-update-71)).

**Tax years** (`src/ui/tax-years/tax-year-settings.tsx`; pure logic tested
in `tax-year-model.ts`, texts in `tax-year-messages.ts`, mutations in
`tax-year-mutations.ts`):

- **List** from `useTaxYearList()`, oldest years first: year, status
  (Regelbesteuerung / Kleinunternehmer § 19 UStG) and a "Kleinunternehmer"
  switch (shadcn `Switch`). Years without a record carry "Standard, nicht
  gespeichert". If there are mismatched bookings (`mismatchedBookings > 0`),
  the row shows a hint – permanently, since it comes from `list()`, until the
  bookings are corrected.
- **The switch** saves immediately (`setSmallBusiness`) and shows the new
  value while saving or asking (then `readOnly`, not `disabled`: focus
  stays). On `conflicts` an alert dialog explains that N bookings no longer
  match, stay unchanged and must be corrected on the next edit; "Trotzdem
  ändern" retries with `acknowledgeConflicts: true`, "Abbrechen" (initial
  focus) resets the switch. Success: toast.
- **Add year:** small form (same validation pattern as the other forms;
  client check empty/not a year 1000–9999, service errors
  `invalidYear`/`yearExists` at the field). Suggestion: the current year if
  not listed, otherwise the next one.
- **Invalidation:** only `taxYearQueryKeys.all` (list and status per year,
  on which the booking form's VAT field depends). Bookings and categories do
  not change; booking mutations in turn invalidate `taxYearQueryKeys.all`,
  so the hint updates after correcting a booking.

**Stripe** (`src/ui/stripe/stripe-settings-section.tsx`,
`StripeSettingsSection`; pure logic tested in `stripe-settings-model.ts`,
texts in `stripe-messages.ts`, hooks in
`stripe-queries.ts`/`stripe-mutations.ts`):

- **API key:** hint about the required permission ("Application fees:
  Read") and where to create the key. Without a key, a password field
  (`autocomplete="off"`, no spell check) with a client check via
  `validateStripeApiKey`; with a key, the masked form, mode (live/test),
  "Ändern" (field plus "Abbrechen") and "Entfernen" (alert dialog, focus on
  "Abbrechen"; the defaults stay).
- **Defaults:** VAT rate and two category selects (fees: income without a
  tax office category; refunds: expense with "mindert Einnahmen"; without
  archived ones except the stored and the selected one, marked). Without
  stored values the suggestions are preselected and a hint says "noch nicht
  gespeichert"; if stored values have meanwhile become invalid, a hint lists
  the problems. Service errors appear at the field.
- **Test connection** (#29, only with a stored key):
  `stripeSettings.testConnection()` as `useMutation` (no variables, no key
  in the cache); the result appears as `role="status"` below the button
  (texts `testConnectionMessage`/`stripeClientErrorMessage`). A new key
  resets it.
- **Invalidation:** only `stripeQueryKeys.all`. The categories come from
  `useCategoryList()`; validity and suggestions are computed in the UI from
  the current category list (`validateStripeDefaults`,
  `suggestStripeDefaults`) – so category mutations need not invalidate the
  Stripe keys.

### Stripe import dialog (#31)

"Stripe importieren" in the booking list's "…" menu (below "CSV
exportieren") opens a dialog (`src/ui/stripe/stripe-import-dialog.tsx`).
Pure logic (default range, client checks, result → summary, amounts in
foreign currencies, link filter) lives tested in `stripe-import-model.ts`,
texts for codes in `stripe-messages.ts`.

`stripeCurrencyDecimals` converts amounts in foreign currencies (only in the
list of entries not booked) with **Stripe's** decimal places, not those of
CLDR/`Intl`: zero places only for Stripe's zero-decimal list
(`bif clp djf gnf jpy kmf krw mga pyg rwf ugx vnd vuv xaf xof xpf`), three
for `bhd jod kwd omr tnd`, otherwise two – also for HUF, ISK, IDR or COP,
which CLDR lists without decimals but Stripe sends ×100.

- **Prerequisites:** without a key (`useStripeSettings().apiKey === null`)
  or with missing/invalid defaults (`validateStripeDefaults` against the
  current category list) the dialog only shows a hint and "Zu den
  Einstellungen", no form.
- **Test key** (`mode: "test"`): warning that test fees end up as real
  bookings in the books and the EÜR, plus a required checkbox "trotzdem
  importieren" (client check like a field). Deliberately not forbidden:
  useful for trying things out; the bookings can be found via source Stripe
  and deleted. The summary repeats the hint (`keyMode` of the result).
- **Range:** two date fields (TanStack Form, same validation pattern as the
  other forms). Default `defaultImportPeriod(status, today)`: from
  `lastImportTo` (the same day again), without a previous import from
  1 January of the current year, to today; "today" is the calendar day in
  Europe/Berlin (`berlinTodayIsoDate`), like the service's `inFuture` check.
  A stored end after today (clock set back) starts today. Above it "Letzter
  Import: TT.MM.JJJJ, HH:MM (bis TT.MM.JJJJ)". Client checks mirror the
  service (`required`, `invalidDate`, `inFuture` before `beforeFrom`); its
  field errors appear as `onServer` at the field.
- **Flow:** `useStripeImport()` (`useMutation`, variables only the range).
  During the import the dialog cannot be closed (no close button,
  Escape/click outside ignored, `aria-busy`), the button shows a spinner and
  "Importiere …" and keeps focus – the import is all or nothing and cannot be
  cancelled.
- **Result:** "X neu, Y übersprungen" (possibly ", Z nicht gebucht"), below
  it per fees/refunds, then a table of the entries not booked (type, Stripe
  ID, date, amount in its currency, reason; for `invalidBooking` the booking
  service's field errors). "Buchungen anzeigen" leads to the list with
  `from`/`to` = range and `source=stripe`. Focus jumps to the result's
  heading; an always present `role="status"` region announces progress and
  result.
- **Errors:** `noApiKey`/`invalidDefaults` → hint with a link to the
  settings (settings and, for `invalidDefaults`, also the categories are
  reloaded; the dialog then switches to the hint, which takes focus),
  `stripe` → `stripeClientErrorMessage`, `settingsChanged` → "erneut
  importieren"; unexpected errors → toast and message (nothing booked).
  Messages as `role="alert"`, focused.
- **Invalidation** after success: `bookingQueryKeys.all`,
  `categoryQueryKeys.all` (`bookingCount`), `taxYearQueryKeys.all` (years
  with bookings), `euerQueryKeys.all` and `stripeImportQueryKeys.all`
  (status → next default range); after `noApiKey`/`invalidDefaults`/
  `settingsChanged` `stripeQueryKeys.all`, after `invalidDefaults`
  additionally `categoryQueryKeys.all` (the UI checks the validity of the
  defaults against the category list).
- **"Today"** is fixed when opening and applies while the dialog is open
  (maximum of the date fields, client check `inFuture`); the service's check
  at import time is authoritative.

### Backup (#32)

"Backup erstellen" in the **Datensicherung** section on `/settings`
(`src/ui/backup/backup-section.tsx`, `BackupSection`; hook `useCreateBackup`
in `backup-mutations.ts`) saves a copy of the whole database to a location
chosen via the save dialog. Restoring is manual
([Data model](data-model.md#backup-and-restore-32)).

| File                                      | Responsibility                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/business/backup/backup-service.ts`   | `createBackupService({ savePathPicker, databaseBackup, clock })`, port `DatabaseBackup`      |
| `src/business/backup/backup-target.ts`    | Guard: `isInDatabaseFolder`, `BackupTargetInDatabaseFolderError`, `BackupWriteError`         |
| `src/business/backup/backup-file-name.ts` | File name suggestion `belegwerk-backup-YYYY-MM-DD_HHMM.db` (Europe/Berlin)                   |
| `src/business/files.ts`                   | Port `SavePathPicker` (`pickSavePath` → path or `null`), `safeFileNamePart`                  |
| `src/persistence/backup.ts`               | `writeDatabaseBackup(connection, path)`: `VACUUM INTO ?` + check; `Database.backupTo`        |
| `src/app/tauri-file-saver.ts`             | `createTauriSavePathPicker()`: only the save dialog                                          |
| `src/app/tauri-database-backup.ts`        | `createTauriDatabaseBackup(database)`: clear the target file, then `database.backupTo(path)` |

- **Flow** (`backup.createBackup({ fileNameBase, filterName })`): save
  dialog with suggestion `belegwerk-backup-2026-11-14_1530.db` (date and time
  in Europe/Berlin, filter "SQLite-Datenbank", `*.db`) → cancel:
  `{ saved: false }`, nothing written → otherwise write the backup,
  `{ saved: true, fileName, path }`. Errors throw.
- **`VACUUM INTO ?`** is written by SQLite itself: a transactionally
  consistent, compacted copy in one file (journal mode of the copy
  `DELETE`). The path is a **bound parameter**, never part of the SQL text
  (spaces, umlauts, `'` in the path are no problem). `VACUUM` must not run
  inside a transaction; it therefore runs in an `SqlConnection.exclusive`
  section – a running transaction finishes first, and no other flow gets in
  between.
- **Check afterwards** (in the same `exclusive` section): the copy is
  attached as `backup_check` (`ATTACH DATABASE ? AS backup_check`);
  `PRAGMA backup_check.quick_check` must return exactly `ok` and the copy
  must have as many entries in `sqlite_schema` as the source (an empty file
  would pass `quick_check`). Then `DETACH` – also after an error. Failure:
  `BackupCheckError`. Defensively: a silent `ROLLBACK` before `VACUUM` (in
  case a transaction was left open after all), a silent `DETACH` before
  `ATTACH` (in case `backup_check` is still attached).
- **Never into the app's data folder (protection against data loss).**
  Before any write, `createTauriDatabaseBackup` checks whether the target is
  in the running database's folder (`Database.mainFilePath()` =
  `PRAGMA database_list`, row `main`; compared with `isInDatabaseFolder` from
  `src/business/backup/backup-target.ts`). The folder and everything below
  it is rejected – so `belegwerk.db` itself, `-journal`/`-wal`/`-shm` and any
  other file there. Without this check, clearing (next point) would truncate
  the running database to 0 bytes (SQLite opens it with write sharing, the
  truncation succeeds), and the following `VACUUM INTO` would fail: all data
  gone. Rejection happens with `BackupTargetInDatabaseFolderError`; the
  service returns `{ saved: false, reason: "targetInDatabaseFolder" }`, the
  UI shows "Das Backup kann nicht im Datenordner der App gespeichert werden –
  bitte einen anderen Ort wählen." If the database's path is unknown (empty,
  only for an in-memory DB), nothing is written at all.
  - **Comparison:** paths are normalised (`/` → `\`, prefixes `\\?\`, `\\.\`
    and `\??\` – also before `UNC\` –, duplicate separators, `.`/`..`,
    trailing separators, dots and spaces at the end of each segment – Win32
    ignores them, `de.belegwerk.desktop.\belegwerk.db` is the real file –,
    case). Since the whole folder is blocked, 8.3 short names of the _file_
    are covered too.
  - **Known limits:** symbolic links, junctions, hard links, mapped
    drives/`subst`, UNC paths to the own machine (`\\localhost\C$\…`,
    `\\<machine name>\…`) and 8.3 short names of the _folder_ are not
    resolved (the WebView cannot canonicalise paths). A route via such an
    alias to `belegwerk.db` would not be detected.
- **Existing target file:** `VACUUM INTO` refuses an existing, non-empty
  file ("output file already exists"), but accepts an **empty** one. The
  dialog allows overwriting (it asks beforehand). That is why
  `createTauriDatabaseBackup` clears the chosen file – after the check
  above – with `writeTextFile(path, "")` (creates it or truncates it to 0
  bytes) and then lets SQLite write into it. If the backup fails, the file is
  cleared again (best effort): an empty file is recognisably not a backup, a
  half-written one could be mistaken for one. A previously existing file is
  lost in this case – the user agreed to replace it. Errors come as
  `BackupWriteError` with `targetCleared` (whether the target file had
  already been cleared); the UI then adds "Die Zieldatei wurde geleert."
- **Permissions: none new.** Writing by SQLite runs in the Rust process
  (`tauri-plugin-sql`) and is not subject to the fs scope. For clearing,
  `fs:allow-write-text-file` suffices (as for the CSV export); the dialog
  adds exactly the chosen path to the scope. Rejected: a temporary file +
  `rename`/`copy-file` (would need `fs:allow-rename`/`fs:allow-copy-file`
  plus a static scope for the temporary file, since the dialog only allows
  the chosen path) and deleting via `fs:allow-remove` (additional
  permission, same result as clearing). Rust stays pure plugin
  configuration.
- **Contents:** all tables including `settings` – so also the Stripe key in
  plain text; the section's description points this out.
- **UI:** button "Backup erstellen" (disabled while running but focusable,
  with a spinner), success: toast with file name; cancel: nothing; target in
  the data folder: its own error toast (nothing written); other errors:
  error toast, possibly with "Die Zieldatei wurde geleert." (details in the
  console). Above it the DB's location and a short note on restoring. No
  data changes, so nothing is invalidated.

### Auto-update (#71)

On startup and on request, the app checks whether a newer version is on
GitHub and replaces its `.exe` at the push of a button. Flow, security
checks and release workflow: [Release](release.md#auto-update-71).

| File                                     | Responsibility                                                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src-tauri/src/updater.rs`               | Commands `check_for_update`, `install_update` (GitHub API, download, SHA-256, swap, restart)                                                          |
| `src/business/updates/update-service.ts` | Port `Updater`, `UpdateError` (codes), `createUpdateService({ updater })`, `downloadPercent`                                                          |
| `src/business/updates/calver.ts`         | Version scheme `YYYY-MM-DD-HHMM` (UTC) ↔ SemVer `YYYY.MMDD.HHMM`, next release version (also for `scripts/`, [Release](release.md#version-scheme-71)) |
| `src/app/tauri-updater.ts`               | `createTauriUpdater()`: `invoke` of the commands (progress via `Channel`), `openUrl` from `plugin-opener`                                             |
| `src/ui/updates/`                        | Notice in the top bar, "Updates" section in the settings, texts for codes, query/mutations                                                            |

- **Rust instead of the WebView:** network and file swap run in Rust (no CSP
  extension, no HTTP scope for GitHub). The commands are declared in the
  app manifest (`src-tauri/build.rs`) and can only be called via the
  capability's permissions `allow-check-for-update`/`allow-install-update`.
  `install_update` queries GitHub itself and accepts no URLs from the
  WebView.
- **Versions** are already delivered by Rust as CalVer (`currentVersion`,
  `latestVersion`, e.g. `2026-11-14-2000`; `0.0.0` in development); the UI
  shows them unchanged.
- **Errors** come from Rust as `{ kind, message }`; `createTauriUpdater`
  turns them into an `UpdateError` with `kind` (unknown errors:
  `unexpected`), and the UI translates `kind` (`update-messages.ts`).
- **Startup check:** `useBackgroundUpdateCheck()` (query
  `["updates", "check"]`, once per program run, `staleTime: Infinity`) calls
  `updates.checkInBackground()`: errors are only logged (console, Rust log),
  result `null`, no notice. The notice (`UpdateNotice`, to the left of
  "Einstellungen" in the top bar: an "Update verfügbar" badge that shows the
  version and actions in a popover; the popover stays mounted when closed so
  progress and errors of a running update are kept) only appears with
  `updateAvailable`; "Hinweis ausblenden" hides it for this version until the
  next start.
- **"Nach Updates suchen"** (`UpdateSection`): mutation, result as
  `role="status"` (up to date / newer version / error); a success also writes
  it into the query, so the notice follows.
- **"Jetzt aktualisieren"** (`UpdateActions`, in the notice and the
  settings): mutation with key `["updates", "install"]`; while running, the
  button is disabled (focusable) with a spinner and percentage, with a
  progress bar below. If an update is already running in the other place,
  the button is disabled too. Success: the app restarts (the mutation never
  ends). Error: message (`role="alert"`) adding that the installed version
  is unchanged.
- **Release notes** open in the default browser via `tauri-plugin-opener`;
  the capability only allows
  `https://github.com/patrick-b6n/belegwerk-next/releases/*`, and adapter and
  Rust check the same prefix.

## Release and single instance (#33)

The app ships as a single, unsigned `.exe` without an installer
(`pnpm release`, release profile, version, storage locations, SmartScreen:
[Release](release.md)); every push to `main` creates a release (version =
time in UTC, a new push cancels the running run), and the app updates
itself from it ([Auto-update](#auto-update-71)).
`tauri-plugin-single-instance` is the first plugin in `src-tauri/src/lib.rs`:
a second start exits and brings the running instance's `main` window to the
front – two processes never open the same database. The plugin has no JS
API, hence no capability.

## Content Security Policy

`src-tauri/tauri.conf.json` sets a CSP: only own scripts, styles (including
inline styles), images/fonts also as `data:`, network only to own assets and
the Tauri IPC. At build time Tauri adds hashes of the pre-rendered shell's
inline scripts to `script-src`; `dangerousDisableAssetCspModification` stays
off. `base-uri` and `form-action` are restricted to `'self'`.

**Caution with styles:** if the built HTML contains a `<style>` element,
Tauri also adds hashes/nonces to `style-src`. Browsers then ignore
`'unsafe-inline'`, and styles inserted at runtime would be blocked.
Currently the shell contains no `<style>` (CSS comes as a file).

In dev mode (`pnpm tauri dev`, page from the Vite server) the CSP does not
apply – CSP problems only show in the built program
(`pnpm tauri build --no-bundle` or `pnpm release`). The Stripe client (#29)
needs no extension: `tauri-plugin-http` executes the request in Rust, and
the WebView only talks via IPC. Likewise the auto-update (#71): GitHub API
and download run in Rust. If a later feature needs real network targets in
the WebView, the CSP is extended specifically.

## Lint & format

| Script              | Purpose                             |
| ------------------- | ----------------------------------- |
| `pnpm lint`         | oxlint (including layer boundaries) |
| `pnpm format`       | oxfmt, formats all files            |
| `pnpm format:check` | oxfmt in check mode (for CI, #7)    |
| `pnpm typecheck`    | compile Paraglide + `tsc -b`        |
| `pnpm db:generate`  | SQL migrations from the schema      |

- **oxlint** ([`.oxlintrc.json`](../.oxlintrc.json)): categories
  `correctness` and `suspicious` as errors, plugins `typescript`, `unicorn`,
  `oxc`, `react` (including hooks rules), `import`, `vitest`. Warnings are
  not used – a rule is either an error or off; `pnpm lint` additionally runs
  with `--deny-warnings` so future warnings fail the run too.
- **oxfmt** ([`.oxfmtrc.json`](../.oxfmtrc.json)): Prettier-compatible,
  `printWidth` 100, otherwise defaults (double quotes, semicolons). Also
  formats JSON, CSS and Markdown.
- Both tools are pinned exactly so formatting and lint results do not flip
  with a minor update.

### shadcn/ui components

The files under `src/ui/components/ui` are treated like own code and
**formatted with oxfmt** (e.g. semicolons instead of shadcn style). After a
`shadcn add`, just run `pnpm format`. There are no lint exceptions; the
enabled categories (`correctness`, `suspicious`) report nothing in the
generated components. Style rules (`style`, `pedantic`) are deliberately
not active so future `shadcn add` runs do not fight lint. If a rule later
reports only in generated components, it is switched off in an override for
`src/ui/components/ui/**` instead of rewriting the component.

## TypeScript configuration

- `tsconfig.app.json` – `src/` (WebView code) without test code, **without**
  Node types.
- `tsconfig.test.json` – test code under `src/` (`*.test.ts[x]`,
  `__tests__/`), inherits from `tsconfig.app.json`, with Node types
  ([Tests](testing.md)).
- `tsconfig.node.json` – configuration files (`vite.config.ts`,
  `vitest.config.ts`, `drizzle.config.ts`), with Node types.
- `tsconfig.json` – only references to all three; `tsc -b` checks all of
  them.

## Tests

Vitest in the Node environment; business with in-memory fakes, persistence
against `better-sqlite3`. Conventions: [docs/testing.md](testing.md).
