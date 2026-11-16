/**
 * Stripe import (#30): books the platform's application fees as income and
 * their refunds as expenses (Erlösminderung) – regular bookings with
 * `source: "stripe"` and the Stripe ID as external ID (docs/architecture.md,
 * "Stripe import (#30)").
 *
 * Flow of `import({ from, to })`:
 * 1. Unit of work: read key and defaults (`loadStripeImportSettings`).
 * 2. **Outside** any unit of work: fetch the fees from `from` minus
 *    {@link STRIPE_FEE_REFUND_LOOKBACK_DAYS} to the end of `to` – no
 *    transaction stays open during the HTTP requests.
 * 3. Select fees whose own `created` is in the range and refunds whose own
 *    `created` is in the range (whatever the fee's date).
 * 3a. Resolve the names of the connected accounts of items not booked yet
 *    (one read-only unit of work for the existing IDs, then Stripe outside
 *    of it) – the counterparty. Without the optional permission or for a
 *    deleted account the `acct_…` ID stays the counterparty.
 * 4. One unit of work: read the settings again (they may have changed during
 *    the request; a different key gives `settingsChanged`), skip external IDs that exist, validate and insert the rest
 *    with the booking rules (`prepareBooking`) and store the last import.
 *    All or nothing: an unexpected error rolls everything back.
 */
import {
  BOOKING_TEXT_MAX_LENGTH,
  type BookingFieldError,
  type BookingFormInput,
  type BookingLookups,
  prepareBooking,
} from "../bookings";
import { parseIsoDate } from "../format";
import type { Category, VatRate } from "../model";
import { MAX_AMOUNT_CENTS } from "../money";
import type { Clock, Repositories, UnitOfWork } from "../repositories";
import {
  type StripeClient,
  type StripeClientError,
  STRIPE_FEE_REFUND_LOOKBACK_DAYS,
} from "./stripe-client";
import {
  bookingDateRangeToStripeCreated,
  stripeCreatedToBookingDate,
  subtractDays,
} from "./stripe-dates";
import {
  maskStripeApiKey,
  STRIPE_SETTING_KEYS,
  type StripeDefaultsFieldError,
  type StripeKeyMode,
} from "./stripe-settings";
import { loadStripeImportSettings } from "./stripe-settings-service";

/**
 * Descriptions of imported bookings. Stored data like the seeded category
 * names (docs/i18n.md: values from the database are not translated), not UI
 * texts – the user may edit them like any booking.
 */
export const STRIPE_BOOKING_DESCRIPTIONS = {
  fee: "Stripe Application Fee",
  refund: "Stripe Application Fee – Rückerstattung",
} as const;

/** The period to import: inclusive booking dates `YYYY-MM-DD` (Europe/Berlin). */
export interface StripeImportRequest {
  readonly from: string;
  readonly to: string;
}

/**
 * - `required` / `invalidDate`: empty, or no existing `YYYY-MM-DD`.
 * - `beforeFrom` (`to`): the period ends before it starts.
 * - `inFuture` (`to`): after today (Europe/Berlin) – it would become the
 *   start of the next import ({@link StripeImportStatus.lastImportTo}).
 */
export interface StripeImportFieldErrorCodes {
  readonly from: "required" | "invalidDate";
  readonly to: "required" | "invalidDate" | "beforeFrom" | "inFuture";
}

export type StripeImportFieldError = {
  readonly [F in keyof StripeImportFieldErrorCodes]: {
    readonly field: F;
    readonly code: StripeImportFieldErrorCodes[F];
  };
}[keyof StripeImportFieldErrorCodes];

/**
 * Why a fee or refund was not booked:
 * - `unsupportedCurrency`: not EUR (#1: EUR only).
 * - `zeroAmount`: amount 0 (bookings need an amount > 0).
 * - `amountTooLarge`: above `MAX_AMOUNT_CENTS`.
 * - `invalidBooking`: the booking rules refused it; see `errors`.
 */
export type StripeImportFailureCode =
  | "unsupportedCurrency"
  | "zeroAmount"
  | "amountTooLarge"
  | "invalidBooking";

export interface StripeImportFailure {
  readonly kind: "fee" | "refund";
  /** `fee_…` or `fr_…`. */
  readonly externalId: string;
  /** Booking date the item would have had. */
  readonly date: string;
  /** In the smallest unit of `currency`. */
  readonly amount: number;
  /** Lowercase, as Stripe sends it. */
  readonly currency: string;
  readonly code: StripeImportFailureCode;
  /** The booking's field errors, only for `invalidBooking`. */
  readonly errors?: readonly BookingFieldError[];
}

export interface StripeImportCounts {
  readonly created: number;
  readonly skipped: number;
  readonly failed: number;
}

export type StripeImportResult =
  | {
      readonly ok: true;
      readonly range: StripeImportRequest;
      /** Mode of the key used – the UI may warn about test data. */
      readonly keyMode: StripeKeyMode;
      /** New bookings (fees and refunds). */
      readonly created: number;
      /** External ID already booked (deleted bookings are created again). */
      readonly skipped: number;
      /** Not booked, oldest first. */
      readonly failed: readonly StripeImportFailure[];
      readonly fees: StripeImportCounts;
      readonly refunds: StripeImportCounts;
    }
  | {
      readonly ok: false;
      readonly reason: "invalid";
      readonly errors: readonly StripeImportFieldError[];
    }
  /** No (valid) key stored – #31 links to the settings. */
  | { readonly ok: false; readonly reason: "noApiKey" }
  | {
      readonly ok: false;
      readonly reason: "invalidDefaults";
      readonly errors: readonly StripeDefaultsFieldError[];
    }
  /**
   * The API key was replaced while Stripe answered: the fetched fees may
   * belong to another account, so nothing was written. Import again.
   */
  | { readonly ok: false; readonly reason: "settingsChanged" }
  /** Stripe refused or was not reachable; nothing was written. */
  | { readonly ok: false; readonly reason: "stripe"; readonly error: StripeClientError };

/** What #31 needs to suggest the next period. */
export interface StripeImportStatus {
  /** When the last successful import ran (`toISOString()`), `null` if never. */
  readonly lastImportAt: string | null;
  /**
   * The latest period end imported so far (`YYYY-MM-DD`), `null` if never –
   * the default start of the next import („seit dem letzten Import“): that
   * day again, since fees of the rest of the day may have come in after the
   * import; already booked ones are skipped.
   */
  readonly lastImportTo: string | null;
}

export interface StripeImportService {
  import(request: StripeImportRequest): Promise<StripeImportResult>;
  getStatus(): Promise<StripeImportStatus>;
}

export interface StripeImportServiceDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly stripeClient: StripeClient;
  readonly clock: Clock;
}

/** One fee or refund to book. */
interface ImportItem {
  readonly kind: "fee" | "refund";
  readonly id: string;
  readonly amount: number;
  readonly currency: string;
  readonly created: number;
  readonly account: string;
  /** The refunded fee (refunds only). */
  readonly feeId: string | null;
}

export function createStripeImportService({
  unitOfWork,
  stripeClient,
  clock,
}: StripeImportServiceDependencies): StripeImportService {
  return {
    getStatus: () =>
      unitOfWork.run(async (repos) => {
        const at = await repos.settings.get(STRIPE_SETTING_KEYS.lastImportAt);
        const to = await repos.settings.get(STRIPE_SETTING_KEYS.lastImportTo);
        return {
          lastImportAt: at !== undefined && !Number.isNaN(Date.parse(at)) ? at : null,
          lastImportTo: to !== undefined && parseIsoDate(to) ? to : null,
        };
      }),

    import: async (request) => {
      const today = stripeCreatedToBookingDate(Math.floor(clock().getTime() / 1000));
      const errors = validateRange(request, today);
      if (errors.length > 0) return { ok: false, reason: "invalid", errors };
      const { from, to } = request;
      const range = bookingDateRangeToStripeCreated(from, to);

      const settings = await unitOfWork.run(loadStripeImportSettings);
      if (!settings.ok) return settings;

      const listed = await stripeClient.listApplicationFees({
        apiKey: settings.apiKey,
        createdFrom: subtractDays(range.createdFrom, STRIPE_FEE_REFUND_LOOKBACK_DAYS),
        createdTo: range.createdTo,
      });
      if (!listed.ok) return { ok: false, reason: "stripe", error: listed.error };

      const inRange = (created: number) =>
        created >= range.createdFrom && created <= range.createdTo;
      const items = new Map<string, ImportItem>();
      for (const fee of listed.fees) {
        if (inRange(fee.created) && !items.has(fee.id)) {
          const { id, amount, currency, created, account } = fee;
          items.set(id, { kind: "fee", id, amount, currency, created, account, feeId: null });
        }
        for (const refund of fee.refunds) {
          if (inRange(refund.created) && !items.has(refund.id)) {
            items.set(refund.id, {
              kind: "refund",
              ...refund,
              account: fee.account,
              feeId: fee.id,
            });
          }
        }
      }
      // Oldest first, a fee before its refund: booking ids follow the dates.
      const sorted = [...items.values()];
      sorted.sort(
        (a, b) =>
          a.created - b.created ||
          (a.kind === b.kind ? 0 : a.kind === "fee" ? -1 : 1) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );

      const existing = await unitOfWork.run((repos) =>
        repos.bookings.findExistingExternalIds(
          "stripe",
          sorted.map((item) => item.id),
        ),
      );
      const accounts = [
        ...new Set(sorted.filter((item) => !existing.has(item.id)).map((item) => item.account)),
      ];
      const counterparties = new Map<string, string>();
      for (const accountId of accounts) {
        const resolved = await stripeClient.getAccountName({ apiKey: settings.apiKey, accountId });
        if (resolved.ok) {
          if (resolved.name !== null) counterparties.set(accountId, fitCounterparty(resolved.name));
        } else if (!isMissingAccountName(resolved.error)) {
          return { ok: false, reason: "stripe", error: resolved.error };
        }
      }

      return unitOfWork.run(async (repos): Promise<StripeImportResult> => {
        // Again in the writing transaction: key or defaults may have changed
        // (category archived) while Stripe answered.
        const current = await loadStripeImportSettings(repos);
        if (!current.ok) return current;
        // The fees belong to the account of the key used for the request; a
        // different key now may be another account – book nothing.
        if (current.apiKey !== settings.apiKey) return { ok: false, reason: "settingsChanged" };
        const booked = await book(repos, sorted, current, counterparties);
        await repos.settings.set(STRIPE_SETTING_KEYS.lastImportAt, clock().toISOString());
        const previousTo = await repos.settings.get(STRIPE_SETTING_KEYS.lastImportTo);
        if (previousTo === undefined || !parseIsoDate(previousTo) || previousTo < to) {
          await repos.settings.set(STRIPE_SETTING_KEYS.lastImportTo, to);
        }
        return {
          ok: true,
          range: { from, to },
          keyMode: maskStripeApiKey(current.apiKey).mode,
          ...booked,
        };
      });
    },
  };
}

/**
 * Lookup failures that keep the `acct_…` ID as counterparty instead of
 * failing the import: the key lacks the optional "Accounts: Read" (403) or
 * the account is gone (404).
 */
function isMissingAccountName(error: StripeClientError): boolean {
  return (
    error.code === "permissionDenied" || (error.code === "stripeError" && error.status === 404)
  );
}

/** Cuts an overlong name to the counterparty limit (whole code points). */
function fitCounterparty(name: string): string {
  const max = BOOKING_TEXT_MAX_LENGTH.counterparty;
  if (name.length <= max) return name;
  let result = "";
  for (const char of name) {
    if (result.length + char.length > max) break;
    result += char;
  }
  return result;
}

function validateRange(request: StripeImportRequest, today: string): StripeImportFieldError[] {
  const errors: StripeImportFieldError[] = [];
  const fromError = checkDate(request.from);
  const toError = checkDate(request.to);
  if (fromError) errors.push({ field: "from", code: fromError });
  if (toError) errors.push({ field: "to", code: toError });
  else if (request.to > today) errors.push({ field: "to", code: "inFuture" });
  else if (!fromError && request.to < request.from) {
    errors.push({ field: "to", code: "beforeFrom" });
  }
  return errors;
}

function checkDate(value: unknown): "required" | "invalidDate" | undefined {
  if (typeof value !== "string" || value.trim() === "") return "required";
  return parseIsoDate(value) === undefined ? "invalidDate" : undefined;
}

interface ImportDefaults {
  readonly defaultVatRate: VatRate;
  readonly feeCategory: Category;
  readonly refundCategory: Category;
}

async function book(
  repos: Repositories,
  items: readonly ImportItem[],
  defaults: ImportDefaults,
  /** Resolved account names by `acct_…` ID; missing ones book the ID. */
  counterparties: ReadonlyMap<string, string>,
): Promise<
  Pick<
    Extract<StripeImportResult, { ok: true }>,
    "created" | "skipped" | "failed" | "fees" | "refunds"
  >
> {
  const existing = await repos.bookings.findExistingExternalIds(
    "stripe",
    items.map((item) => item.id),
  );
  // Loaded once for the batch; the booking rules read through these lookups.
  const categories = new Map((await repos.categories.list()).map((c) => [c.id, c]));
  const smallBusiness = new Map(
    (await repos.taxYears.list()).map((year) => [year.year, year.smallBusiness]),
  );
  const lookups: BookingLookups = {
    findCategory: (id) => Promise.resolve(categories.get(id)),
    isSmallBusinessYear: (year) => Promise.resolve(smallBusiness.get(year) ?? false),
    externalIdExists: (source, id) => Promise.resolve(source === "stripe" && existing.has(id)),
  };

  const counts = {
    fee: { created: 0, skipped: 0, failed: 0 },
    refund: { created: 0, skipped: 0, failed: 0 },
  };
  const failed: StripeImportFailure[] = [];

  for (const item of items) {
    if (existing.has(item.id)) {
      counts[item.kind].skipped += 1;
      continue;
    }
    const date = stripeCreatedToBookingDate(item.created);
    const fail = (code: StripeImportFailureCode, errors?: readonly BookingFieldError[]) => {
      counts[item.kind].failed += 1;
      failed.push({
        kind: item.kind,
        externalId: item.id,
        date,
        amount: item.amount,
        currency: item.currency,
        code,
        ...(errors ? { errors } : {}),
      });
    };
    if (item.currency !== "eur") {
      fail("unsupportedCurrency");
      continue;
    }
    if (item.amount === 0) {
      fail("zeroAmount");
      continue;
    }
    if (item.amount > MAX_AMOUNT_CENTS) {
      fail("amountTooLarge");
      continue;
    }
    const year = parseIsoDate(date)?.year;
    const input: BookingFormInput = {
      date,
      type: item.kind === "fee" ? "income" : "expense",
      grossCents: item.amount,
      // The default rate applies in regularly taxed years only (#28).
      vatRate: year !== undefined && smallBusiness.get(year) ? null : defaults.defaultVatRate,
      categoryId: item.kind === "fee" ? defaults.feeCategory.id : defaults.refundCategory.id,
      description: STRIPE_BOOKING_DESCRIPTIONS[item.kind],
      counterparty: counterparties.get(item.account) ?? item.account,
      // A refund points to the refunded fee (the fee's external ID).
      reference: item.feeId,
      note: null,
      source: "stripe",
      externalId: item.id,
    };
    const prepared = await prepareBooking(input, lookups);
    if (!prepared.ok) {
      fail("invalidBooking", prepared.errors);
      continue;
    }
    await repos.bookings.insert(prepared.input);
    existing.add(item.id);
    counts[item.kind].created += 1;
  }

  return {
    created: counts.fee.created + counts.refund.created,
    skipped: counts.fee.skipped + counts.refund.skipped,
    failed,
    fees: counts.fee,
    refunds: counts.refund,
  };
}
