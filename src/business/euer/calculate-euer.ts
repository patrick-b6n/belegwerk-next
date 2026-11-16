/**
 * EÜR calculation (#25): sums per EÜR position for one calendar year.
 *
 * Pure function over the year's booking sums per category, type and VAT
 * rate (`BookingRepository.sumByCategoryAndVatRate`) and the categories; the
 * service (`euer-service.ts`) loads both in one unit of work. Every rule is
 * documented in docs/data-model.md, "EÜR calculation (#25)":
 *
 * - The **tax status of the year** decides, not the VAT rate of a booking.
 *   Small business: gross into the category's position, turnover remapped to
 *   line 12 (`positionForTaxStatus`), no VAT positions. Regularly taxed: net
 *   into the position, the VAT share of income into `UST_VEREINNAHMT`, of
 *   expenses into `VORSTEUER`.
 * - Regularly taxed turnover goes by the booking's rate: `"7"`/`"19"` →
 *   `BETRIEBSEINNAHMEN_UST_PFLICHTIG` (15), `"0"`/`"reverse_charge"`/none →
 *   `BETRIEBSEINNAHMEN_UST_FREI` (16), whatever turnover position the
 *   category has.
 * - Erlösminderung categories (`reducesIncome`, recognized by flag and
 *   position, never by name) subtract from their income position; their VAT
 *   share reduces `UST_VEREINNAHMT`. Lines may become negative.
 * - VAT payments to / refunds from the tax office (`UST_AN_FA`,
 *   `UST_ERSTATTUNG`) always count in full (gross), whatever their rate.
 * - Small business line 13 ("davon nicht steuerbar") is approximated by the
 *   amounts of `BETRIEBSEINNAHMEN_UST_FREI` categories; informational only.
 * - Bewirtung: 30 % of the line total is not deductible (rounded half up,
 *   once per year); only the deductible 70 % count as expense.
 *
 * Amounts are integer cents; the sums add the stored per-booking net/VAT
 * amounts (never recomputed from gross sums). `MAX_AMOUNT_CENTS` keeps them
 * exact JS numbers.
 */
import type { BookingType, Category, VatRate } from "../model";
import type { BookingGroupSums } from "../repositories";
import { validateCategoryPosition } from "./category-position";
import { describePosition, hasLineMapping } from "./line-mapping";
import {
  EUER_POSITION_DEFINITIONS,
  EUER_POSITIONS,
  type EuerPosition,
  positionForTaxStatus,
} from "./positions";

/** The category fields the calculation reads. */
export type EuerCategory = Pick<Category, "id" | "type" | "euerPosition" | "reducesIncome">;

export interface EuerInput {
  readonly year: number;
  /** Tax status of the year (a year without a record is regularly taxed). */
  readonly smallBusiness: boolean;
  /** Booking sums of the year; several groups with the same key are added. */
  readonly groups: readonly BookingGroupSums[];
  /** All categories, including archived ones. */
  readonly categories: readonly EuerCategory[];
}

/**
 * The bookings of one category and booking type that make up (part of) a
 * line – for the drill-down into the booking list (#26): filter by
 * `categoryId`, `bookingType` and the year, plus `vatRates` where a line
 * takes only some rates of a category (VAT lines, lines 15/16).
 */
export interface EuerContribution {
  readonly categoryId: number;
  readonly bookingType: BookingType;
  /** VAT rates of the contributing bookings (`null` = none), in the order none, 0, 7, 19, reverse charge. */
  readonly vatRates: readonly (VatRate | null)[];
  readonly bookingCount: number;
  /** Signed: negative for Erlösminderung. Sums to the line total. */
  readonly amountCents: number;
}

/** Bewirtung (line 63 in 2025, 64 in 2026): the two columns of the form. */
export interface EntertainmentSplit {
  /** All entertainment expenses of the year (sum of the contributions). */
  readonly totalCents: number;
  /** 70 % – counted as expense (`amountCents` of the line). */
  readonly deductibleCents: number;
  /** 30 % (rounded half up) – not deductible (§ 4 Abs. 5 Satz 1 Nr. 2 EStG). */
  readonly nonDeductibleCents: number;
}

export interface EuerReportLine {
  readonly position: EuerPosition;
  /** Line number in the year's Anlage EÜR; absent without a mapping. */
  readonly line?: number;
  /** Official line text; absent without a mapping (UI shows the position's display name). */
  readonly label?: string;
  /** Amount of the line as it counts in the totals; may be negative (Erlösminderung). */
  readonly amountCents: number;
  /** Bookings contributing to the line. */
  readonly bookingCount: number;
  /** Only for `BEWIRTUNG`. */
  readonly entertainment?: EntertainmentSplit;
  /** Ordered by category id, then booking type. */
  readonly contributions: readonly EuerContribution[];
}

export type EuerWarning =
  /** Bookings with a VAT rate in a small-business year; their rate was ignored (gross counted). */
  | { readonly code: "vatRateInSmallBusinessYear"; readonly bookingCount: number }
  /** Bookings without a VAT rate in a regularly taxed year; counted with net = gross, no VAT. */
  | { readonly code: "vatRateMissingInRegularYear"; readonly bookingCount: number }
  /**
   * Bookings of a tax-office category (`UST_ERSTATTUNG`, `UST_AN_FA`) with
   * rate 7/19 in a regularly taxed year: counted with their full gross
   * amount, the rate was ignored.
   */
  | { readonly code: "vatRateOnTaxPayment"; readonly bookingCount: number }
  /**
   * Bookings that could not be assigned and are **not** counted: unknown
   * category, category of the other type, or an invalid position/flag (e.g.
   * a position key from a newer app version).
   */
  | {
      readonly code: "unassignableBookings";
      readonly bookingCount: number;
      readonly categoryIds: readonly number[];
    }
  /** A line is negative (Erlösminderung larger than the income of its line). */
  | { readonly code: "negativeLine"; readonly position: EuerPosition }
  /** Bewirtung present: only 70 % count as expense (see the line's `entertainment`). */
  | { readonly code: "entertainmentSplit" }
  /** Verpflegungsmehraufwand present: deductible only up to the flat rates – amounts are counted as recorded. */
  | { readonly code: "mealAllowanceFlatRates" };

export type EuerWarningCode = EuerWarning["code"];

export interface EuerTotals {
  /** Sum of the income lines (without informational lines). */
  readonly incomeCents: number;
  /** Sum of the expense lines. */
  readonly expenseCents: number;
  /** Gewinn (positive) or Verlust (negative): income − expenses. */
  readonly profitCents: number;
}

export interface EuerResult {
  readonly year: number;
  readonly smallBusiness: boolean;
  /** Whether line numbers and labels exist for the year (hint in the view, #26). */
  readonly hasLineMapping: boolean;
  /** Income lines, by line number (by position order without a mapping). */
  readonly income: readonly EuerReportLine[];
  /** Expense lines, same order. */
  readonly expenses: readonly EuerReportLine[];
  /** "Davon" lines, not part of the totals (small business line 13). */
  readonly informational: readonly EuerReportLine[];
  readonly totals: EuerTotals;
  /** Codes for the UI, in a fixed order (see {@link EuerWarning}). */
  readonly warnings: readonly EuerWarning[];
}

/** Share of Bewirtung that is not deductible, in percent. */
export const ENTERTAINMENT_NON_DEDUCTIBLE_PERCENT = 30;

const VAT_RATE_ORDER: readonly (VatRate | null)[] = [null, "0", "7", "19", "reverse_charge"];

interface ContributionAccumulator {
  readonly categoryId: number;
  readonly bookingType: BookingType;
  readonly vatRates: Set<VatRate | null>;
  bookingCount: number;
  amountCents: number;
}

type LineAccumulator = Map<string, ContributionAccumulator>;

export function calculateEuer(input: EuerInput): EuerResult {
  const { year, smallBusiness } = input;
  const categories = new Map(input.categories.map((category) => [category.id, category]));
  const lines = new Map<EuerPosition, LineAccumulator>();
  let vatRateInSmallBusinessYear = 0;
  let vatRateMissingInRegularYear = 0;
  let vatRateOnTaxPayment = 0;
  let unassignable = 0;
  const unassignableCategoryIds = new Set<number>();

  const add = (position: EuerPosition, group: BookingGroupSums, amountCents: number) => {
    let line = lines.get(position);
    if (!line) {
      line = new Map();
      lines.set(position, line);
    }
    const key = `${group.categoryId}|${group.type}`;
    let contribution = line.get(key);
    if (!contribution) {
      contribution = {
        categoryId: group.categoryId,
        bookingType: group.type,
        vatRates: new Set(),
        bookingCount: 0,
        amountCents: 0,
      };
      line.set(key, contribution);
    }
    contribution.vatRates.add(group.vatRate);
    contribution.bookingCount += group.count;
    contribution.amountCents += amountCents;
  };

  for (const group of input.groups) {
    if (group.count === 0) continue;
    const category = categories.get(group.categoryId);
    if (!category || category.type !== group.type || !validateCategoryPosition(category).ok) {
      unassignable += group.count;
      unassignableCategoryIds.add(group.categoryId);
      continue;
    }
    // Valid per validateCategoryPosition.
    const position = category.euerPosition as EuerPosition;
    const definition = EUER_POSITION_DEFINITIONS[position];
    const sign = category.reducesIncome ? -1 : 1;

    if (smallBusiness && group.vatRate !== null) vatRateInSmallBusinessYear += group.count;
    if (!smallBusiness && group.vatRate === null) vatRateMissingInRegularYear += group.count;
    const taxed = group.vatRate === "7" || group.vatRate === "19";

    if (definition.taxOfficePayment) {
      // VAT paid to / refunded by the tax office: the full amount, never split.
      // In a small-business year the rate is already reported as mismatched.
      if (taxed && !smallBusiness) vatRateOnTaxPayment += group.count;
      add(position, group, sign * group.grossCents);
      continue;
    }

    if (smallBusiness) {
      add(positionForTaxStatus(position, true), group, sign * group.grossCents);
      if (position === "BETRIEBSEINNAHMEN_UST_FREI") {
        add("BETRIEBSEINNAHMEN_KLEINUNTERNEHMER_NICHT_STEUERBAR", group, sign * group.grossCents);
      }
      continue;
    }

    const target =
      definition.smallBusinessPosition === undefined
        ? position
        : taxed
          ? "BETRIEBSEINNAHMEN_UST_PFLICHTIG"
          : "BETRIEBSEINNAHMEN_UST_FREI";
    add(target, group, sign * group.netCents);
    if (taxed) {
      // An Erlösminderung has an income position: its VAT share corrects the VAT collected.
      add(
        definition.kind === "income" ? "UST_VEREINNAHMT" : "VORSTEUER",
        group,
        sign * group.vatCents,
      );
    }
  }

  const mapped = hasLineMapping(year);
  const income: EuerReportLine[] = [];
  const expenses: EuerReportLine[] = [];
  const informational: EuerReportLine[] = [];
  const warnings: EuerWarning[] = [];

  for (const [position, accumulator] of lines) {
    const line = toReportLine(position, accumulator, year);
    const definition = EUER_POSITION_DEFINITIONS[position];
    if (definition.informational) informational.push(line);
    else if (definition.kind === "income") income.push(line);
    else expenses.push(line);
  }
  for (const list of [income, expenses, informational]) list.sort(byLine);

  const incomeCents = sum(income);
  const expenseCents = sum(expenses);

  if (vatRateInSmallBusinessYear > 0) {
    warnings.push({ code: "vatRateInSmallBusinessYear", bookingCount: vatRateInSmallBusinessYear });
  }
  if (vatRateMissingInRegularYear > 0) {
    warnings.push({
      code: "vatRateMissingInRegularYear",
      bookingCount: vatRateMissingInRegularYear,
    });
  }
  if (vatRateOnTaxPayment > 0) {
    warnings.push({ code: "vatRateOnTaxPayment", bookingCount: vatRateOnTaxPayment });
  }
  if (unassignable > 0) {
    const categoryIds = [...unassignableCategoryIds];
    categoryIds.sort((a, b) => a - b);
    warnings.push({ code: "unassignableBookings", bookingCount: unassignable, categoryIds });
  }
  for (const line of [...income, ...informational, ...expenses]) {
    if (line.amountCents < 0) warnings.push({ code: "negativeLine", position: line.position });
  }
  if (lines.has("BEWIRTUNG")) warnings.push({ code: "entertainmentSplit" });
  if (lines.has("VERPFLEGUNGSMEHRAUFWAND")) warnings.push({ code: "mealAllowanceFlatRates" });

  return {
    year,
    smallBusiness,
    hasLineMapping: mapped,
    income,
    expenses,
    informational,
    totals: { incomeCents, expenseCents, profitCents: incomeCents - expenseCents },
    warnings,
  };
}

function toReportLine(
  position: EuerPosition,
  accumulator: LineAccumulator,
  year: number,
): EuerReportLine {
  const contributions = [...accumulator.values()].map((contribution): EuerContribution => ({
    categoryId: contribution.categoryId,
    bookingType: contribution.bookingType,
    vatRates: VAT_RATE_ORDER.filter((rate) => contribution.vatRates.has(rate)),
    bookingCount: contribution.bookingCount,
    amountCents: contribution.amountCents,
  }));
  contributions.sort(
    (a, b) =>
      a.categoryId - b.categoryId ||
      Number(a.bookingType === "income") - Number(b.bookingType === "income"),
  );
  const totalCents = contributions.reduce((total, { amountCents }) => total + amountCents, 0);
  const bookingCount = contributions.reduce((total, c) => total + c.bookingCount, 0);
  const { line, label } = describePosition(position, year);
  const description = line === undefined ? {} : { line, label };

  if (position === "BEWIRTUNG") {
    const entertainment = splitEntertainment(totalCents);
    return {
      position,
      ...description,
      amountCents: entertainment.deductibleCents,
      bookingCount,
      entertainment,
      contributions,
    };
  }
  return { position, ...description, amountCents: totalCents, bookingCount, contributions };
}

/**
 * 70/30 split of the Bewirtung total. The non-deductible 30 % are rounded
 * half up (away from zero) once on the year's total; the deductible part is
 * the rest, so both columns add up to the total.
 */
export function splitEntertainment(totalCents: number): EntertainmentSplit {
  const magnitude = BigInt(Math.abs(totalCents));
  const nonDeductible = Number(
    (magnitude * BigInt(ENTERTAINMENT_NON_DEDUCTIBLE_PERCENT) * 2n + 100n) / 200n,
  );
  const nonDeductibleCents = totalCents < 0 ? -nonDeductible : nonDeductible;
  return {
    totalCents,
    deductibleCents: totalCents - nonDeductibleCents,
    nonDeductibleCents,
  };
}

const POSITION_INDEX = new Map(EUER_POSITIONS.map((position, index) => [position, index]));

/** By line number; lines without a number after those with one, by position order. */
function byLine(a: EuerReportLine, b: EuerReportLine): number {
  const lineA = a.line ?? Number.POSITIVE_INFINITY;
  const lineB = b.line ?? Number.POSITIVE_INFINITY;
  if (lineA !== lineB) return lineA - lineB;
  return (POSITION_INDEX.get(a.position) ?? 0) - (POSITION_INDEX.get(b.position) ?? 0);
}

function sum(lines: readonly EuerReportLine[]): number {
  return lines.reduce((total, line) => total + line.amountCents, 0);
}
