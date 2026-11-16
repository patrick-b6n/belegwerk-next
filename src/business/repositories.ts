/**
 * Repository interfaces (ports, #11): thin data access without business
 * rules. Validation (required fields, amounts, category type, archived
 * categories, tax status) belongs to the services (#14 ff.), which run
 * against these interfaces. src/persistence implements them with Drizzle,
 * business tests use the in-memory fakes in `__tests__/`.
 *
 * Rules for callers (docs/architecture.md, "Repositories and unit of work (#11)"):
 *
 * - Several writes that belong together run in {@link UnitOfWork.run} and use
 *   **only** the repositories passed to the callback. Using other
 *   repositories (or a nested `run`) inside the callback waits for the
 *   running transaction and deadlocks the app.
 * - Constraint violations surface as {@link ConstraintViolationError}.
 *   Services check the conditions beforehand to produce good messages; the
 *   error is the safety net (and covers races).
 */
import type {
  Booking,
  BookingInput,
  BookingSource,
  BookingType,
  Category,
  CategoryChanges,
  CategoryInput,
  TaxYear,
  VatRate,
} from "./model";

export interface BookingRepository {
  findById(id: number): Promise<Booking | undefined>;
  /** Sets `createdAt`/`updatedAt` from the clock. */
  insert(input: BookingInput): Promise<Booking>;
  /** Replaces all fields of the booking; sets `updatedAt`. `undefined` if it does not exist. */
  update(id: number, input: BookingInput): Promise<Booking | undefined>;
  /** `false` if it did not exist. */
  delete(id: number): Promise<boolean>;
  /**
   * Which of `externalIds` already exist for `source` (duplicate protection
   * of the Stripe import, #30). Any number of IDs.
   */
  findExistingExternalIds(
    source: BookingSource,
    externalIds: readonly string[],
  ): Promise<Set<string>>;
  /** Number of bookings using the category (archive or delete, #15). */
  countByCategory(categoryId: number): Promise<number>;
  /**
   * Number of bookings per category id in one query (category list, #15).
   * Categories without bookings are missing from the map.
   */
  countByCategories(): Promise<Map<number, number>>;
  /**
   * Bookings dated in `year`, split by whether a VAT rate is recorded – to
   * decide about changing the year's tax status (#16).
   */
  countVatRateUsage(year: number): Promise<VatRateUsage>;
  /** Distinct years of the booking dates, ascending (tax year list, #16/#20). */
  listYears(): Promise<number[]>;
  /**
   * The bookings matching `criteria.filter` in the order of `criteria.sort`,
   * optionally one window of them (`offset`/`limit`) – the booking search
   * (#21). Filtering, sorting and paging run in SQL. Semantics: see
   * {@link BookingFilter} and {@link BookingSort}.
   */
  search(criteria: BookingSearchCriteria): Promise<Booking[]>;
  /**
   * Number and gross sums of **all** bookings matching `filter` (not just a
   * page) in one aggregate query (#21).
   */
  summarize(filter: BookingFilter): Promise<BookingTotals>;
  /**
   * Sums of the bookings dated in `year`, grouped by category, type and VAT
   * rate (`null` is its own group) in one aggregate query – the input of the
   * EÜR calculation (#25). The sums add the stored per-booking amounts
   * (never recomputed from gross sums). Groups without bookings are absent;
   * ordered by category id, type, VAT rate (`null` first, then by stored
   * text: `"0"`, `"19"`, `"7"`, `"reverse_charge"`).
   */
  sumByCategoryAndVatRate(year: number): Promise<BookingGroupSums[]>;
  /**
   * The distinct values of the text `field` per booking type, with how often
   * and until when they were used, in one aggregate query – the input of the
   * text suggestions of the booking form. Values are compared exactly
   * (case-sensitive, as stored); ordered by type, then value by code point.
   */
  listTextUsage(field: BookingTextField): Promise<BookingTextUsage[]>;
}

/** Text fields of a booking with suggestions from earlier bookings. */
export type BookingTextField = "description" | "counterparty";

/** One group of {@link BookingRepository.listTextUsage}. */
export interface BookingTextUsage {
  readonly text: string;
  readonly type: BookingType;
  /** Number of bookings of `type` with this exact text (≥ 1). */
  readonly count: number;
  /** Latest booking date (`YYYY-MM-DD`) of these bookings. */
  readonly lastDate: string;
}

/** One group of {@link BookingRepository.sumByCategoryAndVatRate}. */
export interface BookingGroupSums {
  readonly categoryId: number;
  readonly type: BookingType;
  readonly vatRate: VatRate | null;
  /** Number of bookings in the group (≥ 1). */
  readonly count: number;
  readonly grossCents: number;
  readonly netCents: number;
  readonly vatCents: number;
}

/**
 * Normalized search filter (#21); all conditions are combined with AND, an
 * absent property does not filter. The service validates user input first
 * (`normalizeBookingQuery`), so repositories may rely on these rules.
 */
export interface BookingFilter {
  /**
   * Non-blank, trimmed text (NFC). Matches when description, counterparty,
   * reference or note contains it as a substring, case-insensitively per
   * character (`textSearchCharClasses`: ASCII and Unicode letters like
   * ä/Ä, ß/ẞ). No wildcards: `%`, `_`, `*`, `?`, `[` are literal.
   */
  readonly text?: string;
  /** Inclusive lower bound of `date` (`YYYY-MM-DD`). */
  readonly dateFrom?: string;
  /** Inclusive upper bound of `date` (`YYYY-MM-DD`). */
  readonly dateTo?: string;
  readonly type?: BookingType;
  /** Any of these categories; non-empty and without duplicates. */
  readonly categoryIds?: readonly number[];
  readonly source?: BookingSource;
  /** Any of these VAT rates (`null` = no rate); non-empty and without duplicates. */
  readonly vatRates?: readonly (VatRate | null)[];
  /** Inclusive lower bound of `grossCents`. */
  readonly amountFrom?: number;
  /** Inclusive upper bound of `grossCents`. */
  readonly amountTo?: number;
}

export type BookingSortField =
  | "date"
  | "description"
  | "counterparty"
  /** By category name. */
  | "category"
  | "netCents"
  | "vatCents"
  | "grossCents"
  | "type"
  | "source";

export type SortDirection = "asc" | "desc";

/**
 * Sort order of the search. Texts (description, counterparty, category
 * name) compare case-insensitively for ASCII letters only (SQLite `NOCASE`),
 * otherwise by code point – umlauts sort after `z`. `type` and `source`
 * compare their stored values (`expense` < `income`, `manual` < `stripe`).
 *
 * Ties: sorting by `date` breaks ties by `id` in the same direction (same
 * day in entry order, or reversed); every other field by `date` descending,
 * then `id` descending. The order is therefore total and stable across pages.
 */
export interface BookingSort {
  readonly field: BookingSortField;
  readonly direction: SortDirection;
}

export interface BookingSearchCriteria {
  readonly filter: BookingFilter;
  readonly sort: BookingSort;
  /** Maximum number of rows (positive integer); absent = all. */
  readonly limit?: number;
  /** Rows to skip (non-negative integer); only together with `limit`. */
  readonly offset?: number;
}

export interface BookingTotals {
  readonly count: number;
  /** Sum of `grossCents` of the matching income bookings. */
  readonly incomeCents: number;
  /** Sum of `grossCents` of the matching expense bookings. */
  readonly expenseCents: number;
}

export interface VatRateUsage {
  readonly withVatRate: number;
  readonly withoutVatRate: number;
}

export interface CategoryRepository {
  /** All categories including archived ones, ordered by id. */
  list(): Promise<Category[]>;
  findById(id: number): Promise<Category | undefined>;
  /**
   * New categories are not archived. Unique per `(type, name)`.
   * `reducesIncome` is only allowed for expense categories – the service
   * validates it; the database rejects it with a raw CHECK error (no
   * {@link ConstraintViolationError}). Same for `update`.
   */
  insert(input: CategoryInput): Promise<Category>;
  /** `undefined` if it does not exist. */
  update(id: number, changes: CategoryChanges): Promise<Category | undefined>;
  /** Archives or reactivates; `undefined` if it does not exist. */
  setArchived(id: number, archived: boolean): Promise<Category | undefined>;
  /**
   * `false` if it did not exist. Fails with a `"foreign_key"`
   * {@link ConstraintViolationError} while bookings use it.
   */
  delete(id: number): Promise<boolean>;
}

export interface TaxYearRepository {
  /** `undefined` if the year has no record (= regularly taxed, #16). */
  find(year: number): Promise<TaxYear | undefined>;
  /** All recorded years, ascending. */
  list(): Promise<TaxYear[]>;
  /** Creates or replaces the record of `taxYear.year`. */
  upsert(taxYear: TaxYear): Promise<TaxYear>;
}

/** Key-value settings (e.g. Stripe key, last import, defaults – #29 ff.). */
export interface SettingsRepository {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  /** `false` if the key did not exist. */
  delete(key: string): Promise<boolean>;
}

export interface Repositories {
  readonly bookings: BookingRepository;
  readonly categories: CategoryRepository;
  readonly taxYears: TaxYearRepository;
  readonly settings: SettingsRepository;
}

/**
 * Runs several repository operations atomically (one database transaction).
 *
 * Inside `fn` use only the `repos` passed to it – never other repositories
 * and no nested `run`: in the app those wait for the transaction to end,
 * which never happens (deadlock). The in-memory fake rejects such calls.
 */
export interface UnitOfWork {
  /** Commits if `fn` resolves; rolls back and rethrows if it rejects. */
  run<T>(fn: (repos: Repositories) => Promise<T>): Promise<T>;
}

/** Current time; injected so tests can use a fixed clock. */
export type Clock = () => Date;

export type ConstraintKind =
  /** A unique key already exists (category `(type, name)`, booking `(source, externalId)`, …). */
  | "unique"
  /** A referenced row is missing, or a row is still referenced (category with bookings). */
  | "foreign_key";

/** A write violated a database constraint the services did not (or could not) check before. */
export class ConstraintViolationError extends Error {
  readonly kind: ConstraintKind;

  constructor(kind: ConstraintKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConstraintViolationError";
    this.kind = kind;
  }
}
