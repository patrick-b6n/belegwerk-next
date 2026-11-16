/**
 * CSV export of the EÜR (#27): maps an {@link EuerResult} to rows of the
 * shared CSV format (`src/business/csv`, same format as the booking export).
 *
 * Layout (docs/architecture.md, "CSV export of the EÜR (#27)"): a header row,
 * then one row per position – income in the order of the view (line 13
 * right after line 12), then expenses – and at the end the totals:
 *
 * | Bereich                           | Zeile | Bezeichnung             | Betrag  | Nicht abziehbar |
 * | --------------------------------- | ----- | ----------------------- | ------- | --------------- |
 * | Betriebseinnahmen                 | 12    | Betriebseinnahmen als … | 1000,00 |                 |
 * | Betriebseinnahmen (nachrichtlich) | 13    | davon nicht steuerbare… | 200,00  |                 |
 * | Betriebsausgaben                  | 64    | Bewirtungsaufwendungen  | 70,00   | 30,00           |
 * | Ergebnis                          |       | Summe Betriebseinnahmen | 1000,00 |                 |
 * | Ergebnis                          |       | Summe Betriebsausgaben  | 70,00   |                 |
 * | Ergebnis                          |       | Gewinn                  | 930,00  |                 |
 *
 * - **Bereich** separates the blocks, so a spreadsheet can filter or sum by
 *   it: summing `Betrag` over "Betriebseinnahmen" gives the income total –
 *   the informational line has its own Bereich and the totals are under
 *   "Ergebnis", so neither is counted twice.
 * - **Betrag** is what counts in the totals (Bewirtung: the deductible
 *   70 %); **Nicht abziehbar** is filled only for Bewirtung (the form's
 *   second column, 30 %), so the total spent is Betrag + Nicht abziehbar.
 * - **Zeile** is empty for a year without line mapping; **Bezeichnung** is
 *   the official label of the year, else the position's display name.
 * - Amounts as in the booking export (`formatAmountPlain`, literals), so
 *   negative lines and a loss stay numbers.
 */
import { type CsvCell, csvLiteral, type CsvRow, toCsv } from "../csv";
import { formatAmountPlain } from "../format";
import type { EuerReportLine, EuerResult } from "./calculate-euer";
import type { EuerPosition } from "./positions";
import { incomeInReportOrder } from "./report-order";

/** The columns of the EÜR export, in file order. */
export const EUER_CSV_COLUMNS = ["section", "line", "label", "amount", "nonDeductible"] as const;

export type EuerCsvColumn = (typeof EUER_CSV_COLUMNS)[number];

/**
 * Texts of the export: they are UI texts (Paraglide), so the UI passes them
 * in (docs/i18n.md). The official line labels are form data and come from
 * the result.
 */
export interface EuerCsvLabels {
  readonly columns: Readonly<Record<EuerCsvColumn, string>>;
  /** Values of the "Bereich" column. */
  readonly sections: {
    readonly income: string;
    /** Informational ("davon") income lines, not part of the totals. */
    readonly informational: string;
    readonly expenses: string;
    /** The totals rows. */
    readonly result: string;
  };
  /** Labels of the totals rows. */
  readonly totals: {
    readonly income: string;
    readonly expenses: string;
    /** Result > 0, < 0 and = 0. */
    readonly profit: string;
    readonly loss: string;
    readonly zero: string;
  };
  /** Display names of the positions, for years without line mapping. */
  readonly positionNames: Readonly<Record<EuerPosition, string>>;
}

const amount = (cents: number) => csvLiteral(formatAmountPlain(cents));

function lineRow(section: string, line: EuerReportLine, labels: EuerCsvLabels): CsvRow {
  const cells: Record<EuerCsvColumn, CsvCell> = {
    section,
    line: line.line === undefined ? null : csvLiteral(String(line.line)),
    label: line.label ?? labels.positionNames[line.position],
    amount: amount(line.amountCents),
    nonDeductible: line.entertainment ? amount(line.entertainment.nonDeductibleCents) : null,
  };
  return EUER_CSV_COLUMNS.map((column) => cells[column]);
}

function totalRow(section: string, label: string, cents: number): CsvRow {
  const cells: Record<EuerCsvColumn, CsvCell> = {
    section,
    line: null,
    label,
    amount: amount(cents),
    nonDeductible: null,
  };
  return EUER_CSV_COLUMNS.map((column) => cells[column]);
}

/**
 * The CSV file of an EÜR (see the module comment). A year without lines
 * gives the header and the three totals rows (all 0).
 */
export function euerToCsv(result: EuerResult, labels: EuerCsvLabels): string {
  const { sections, totals } = labels;
  const { incomeCents, expenseCents, profitCents } = result.totals;
  const resultLabel = profitCents > 0 ? totals.profit : profitCents < 0 ? totals.loss : totals.zero;
  return toCsv([
    EUER_CSV_COLUMNS.map((column) => labels.columns[column]),
    ...incomeInReportOrder(result).map(({ line, informational }) =>
      lineRow(informational ? sections.informational : sections.income, line, labels),
    ),
    ...result.expenses.map((line) => lineRow(sections.expenses, line, labels)),
    totalRow(sections.result, totals.income, incomeCents),
    totalRow(sections.result, totals.expenses, expenseCents),
    totalRow(sections.result, resultLabel, profitCents),
  ]);
}
