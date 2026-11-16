/**
 * Line numbers and official labels of the EÜR positions per tax year (#13).
 *
 * The labels are the line texts of the official form – legal form data like
 * the line numbers, not UI texts (docs/i18n.md). Remarks in the form that are
 * only instructions (references to other lines, the 10-day rule) are left
 * out; text in parentheses that describes the content (examples, inclusions
 * like "auch zurückgezahlte Hilfen/Zuschüsse …") is kept.
 *
 * A position without an entry for a year (or a year without a mapping)
 * falls back to the bare position (see {@link describePosition}). Never
 * guess a line: only add lines verified against the official form.
 *
 * Adding a tax year: see docs/data-model.md, "Adding a new tax year".
 */

import type { EuerPosition } from "./positions";

export interface EuerLine {
  /** Line number ("Zeile") in the Anlage EÜR of the year. */
  readonly line: number;
  /** Line text of the official form. */
  readonly label: string;
}

export type EuerLineMapping = Readonly<Partial<Record<EuerPosition, EuerLine>>>;

/**
 * Line texts of the Anlage EÜR 2025 and 2026 – identical in both forms
 * (verified line by line). A later year with changed texts gets its own
 * labels.
 */
const LABELS_2025_2026: Readonly<Record<EuerPosition, string>> = {
  BETRIEBSEINNAHMEN_KLEINUNTERNEHMER:
    "Betriebseinnahmen als umsatzsteuerlicher Kleinunternehmer (nach § 19 Abs. 1 UStG)",
  BETRIEBSEINNAHMEN_KLEINUNTERNEHMER_NICHT_STEUERBAR:
    "davon nicht steuerbare Umsätze sowie Umsätze nach § 19 Abs. 2 Satz 1 Nr. 1 und 2 sowie " +
    "Satz 2 UStG",
  BETRIEBSEINNAHMEN_UST_PFLICHTIG:
    "Umsatzsteuerpflichtige Betriebseinnahmen (ohne solche zum ermäßigten Steuersatz von 0 %)",
  BETRIEBSEINNAHMEN_UST_FREI:
    "Betriebseinnahmen, die umsatzsteuerfrei (§ 4 UStG) oder nicht umsatzsteuerbar sind oder " +
    "nach § 12 Abs. 3 UStG dem ermäßigten Steuersatz von 0 % unterliegen oder für die der " +
    "Leistungsempfänger die Umsatzsteuer nach § 13b UStG schuldet",
  UST_VEREINNAHMT: "Vereinnahmte Umsatzsteuer sowie Umsatzsteuer auf unentgeltliche Wertabgaben",
  UST_ERSTATTUNG: "Vom Finanzamt erstattete und ggf. verrechnete Umsatzsteuer",
  WAREN: "Waren, Rohstoffe und Hilfsstoffe einschließlich der Nebenkosten",
  FREMDLEISTUNGEN: "Bezogene Fremdleistungen",
  GWG: "Aufwendungen für geringwertige Wirtschaftsgüter nach § 6 Abs. 2 EStG",
  MIETE_GESCHAEFTSRAEUME: "Miete/Pacht für Geschäftsräume und betrieblich genutzte Grundstücke",
  TELEKOMMUNIKATION: "Aufwendungen für Telekommunikation (z. B. Telefon, Internet)",
  REISENEBENKOSTEN: "Übernachtungs- und Reisenebenkosten bei Geschäftsreisen des Steuerpflichtigen",
  FORTBILDUNG: "Fortbildungskosten (ohne Reisekosten)",
  RECHTS_STEUERBERATUNG: "Kosten für Rechts- und Steuerberatung, Buchführung",
  MIETE_LEASING_BEWEGLICH: "Miete/Leasing für bewegliche Wirtschaftsgüter (ohne Kfz)",
  BEITRAEGE_VERSICHERUNGEN:
    "Beiträge, Gebühren, Abgaben und Versicherungen (ohne solche für Gebäude und Kfz)",
  EDV_KOSTEN: "Laufende EDV-Kosten (z. B. Beratung, Wartung, Reparatur)",
  ARBEITSMITTEL: "Arbeitsmittel (z. B. Bürobedarf, Porto, Fachliteratur)",
  WERBUNG: "Werbekosten (z. B. Inserate, Werbespots, Plakate)",
  VORSTEUER: "Gezahlte und nach § 15 UStG abziehbare Vorsteuerbeträge",
  UST_AN_FA: "An das Finanzamt gezahlte und ggf. verrechnete Umsatzsteuer",
  SONSTIGE_AUSGABEN:
    "Übrige unbeschränkt abziehbare Betriebsausgaben " +
    "(auch zurückgezahlte Hilfen/Zuschüsse aufgrund der Corona-Pandemie)",
  BEWIRTUNG: "Bewirtungsaufwendungen",
  VERPFLEGUNGSMEHRAUFWAND: "Verpflegungsmehraufwendungen",
  FAHRTKOSTEN:
    "Sonstige tatsächliche Fahrtkosten ohne AfA und Zinsen (z. B. Reparaturen, Wartungen, " +
    "Treibstoff, Kosten für Flugstrecken, Kosten für öffentliche Verkehrsmittel)",
  FAHRTKOSTEN_PRIVATFAHRZEUG:
    "Fahrtkosten für nicht zum Betriebsvermögen gehörende Fahrzeuge (Nutzungseinlage)",
};

function withLabels(
  lines: Readonly<Partial<Record<EuerPosition, number>>>,
  labels: Readonly<Record<EuerPosition, string>>,
): EuerLineMapping {
  return Object.fromEntries(
    Object.entries(lines).map(([position, line]) => [
      position,
      { line, label: labels[position as EuerPosition] },
    ]),
  );
}

/**
 * Anlage EÜR 2025.
 *
 * Source: BMF-Schreiben vom 29.08.2025, GZ IV C 6 - S 2142/00023/010/001
 * (BStBl I 2025 S. 1652), "Standardisierte Einnahmenüberschussrechnung nach
 * § 60 Absatz 4 EStDV; Anlage EÜR 2025", with the attached form
 * (Vordruck 2025AnlEÜR801–803, "- August 2025 -") and "Anleitung zur Anlage
 * EÜR - August 2025 - Version 1.9.1.1":
 * https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2025-08-29-anlage-EUER-2025.pdf?__blob=publicationFile&v=3
 */
const ANLAGE_EUER_2025 = withLabels(
  {
    BETRIEBSEINNAHMEN_KLEINUNTERNEHMER: 12,
    BETRIEBSEINNAHMEN_KLEINUNTERNEHMER_NICHT_STEUERBAR: 13,
    BETRIEBSEINNAHMEN_UST_PFLICHTIG: 15,
    BETRIEBSEINNAHMEN_UST_FREI: 16,
    UST_VEREINNAHMT: 17,
    UST_ERSTATTUNG: 18,
    WAREN: 27,
    FREMDLEISTUNGEN: 29,
    GWG: 36,
    MIETE_GESCHAEFTSRAEUME: 39,
    TELEKOMMUNIKATION: 43,
    REISENEBENKOSTEN: 44,
    FORTBILDUNG: 45,
    RECHTS_STEUERBERATUNG: 46,
    MIETE_LEASING_BEWEGLICH: 47,
    BEITRAEGE_VERSICHERUNGEN: 49,
    EDV_KOSTEN: 50,
    ARBEITSMITTEL: 51,
    WERBUNG: 54,
    VORSTEUER: 57,
    UST_AN_FA: 58,
    SONSTIGE_AUSGABEN: 60,
    BEWIRTUNG: 63,
    VERPFLEGUNGSMEHRAUFWAND: 64,
    FAHRTKOSTEN: 70,
    FAHRTKOSTEN_PRIVATFAHRZEUG: 71,
  },
  LABELS_2025_2026,
);

/**
 * Anlage EÜR 2026. Compared with 2025, line 27 ("Bildung Rücklage
 * Tierbewertung bei Land- und Forstwirten") is new: the income lines stay,
 * Waren moves from 27 to 29 and every other expense line moves down by one.
 *
 * Source: BMF-Schreiben vom 01.09.2026, GZ IV C 6 - S 2142/00024/010/001,
 * "Standardisierte Einnahmenüberschussrechnung nach § 60 Absatz 4 EStDV;
 * Anlage EÜR 2026", with the attached form (Vordruck 2026AnlEÜR801–803,
 * "- August 2026 -") and "Anleitung zur Anlage EÜR - August 2026 - Version
 * 2.5.1.1":
 * https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2026-09-01-anlage-EUER-2026.pdf?__blob=publicationFile&v=2
 */
const ANLAGE_EUER_2026 = withLabels(
  {
    BETRIEBSEINNAHMEN_KLEINUNTERNEHMER: 12,
    BETRIEBSEINNAHMEN_KLEINUNTERNEHMER_NICHT_STEUERBAR: 13,
    BETRIEBSEINNAHMEN_UST_PFLICHTIG: 15,
    BETRIEBSEINNAHMEN_UST_FREI: 16,
    UST_VEREINNAHMT: 17,
    UST_ERSTATTUNG: 18,
    WAREN: 29,
    FREMDLEISTUNGEN: 30,
    GWG: 37,
    MIETE_GESCHAEFTSRAEUME: 40,
    TELEKOMMUNIKATION: 44,
    REISENEBENKOSTEN: 45,
    FORTBILDUNG: 46,
    RECHTS_STEUERBERATUNG: 47,
    MIETE_LEASING_BEWEGLICH: 48,
    BEITRAEGE_VERSICHERUNGEN: 50,
    EDV_KOSTEN: 51,
    ARBEITSMITTEL: 52,
    WERBUNG: 55,
    VORSTEUER: 58,
    UST_AN_FA: 59,
    SONSTIGE_AUSGABEN: 61,
    BEWIRTUNG: 64,
    VERPFLEGUNGSMEHRAUFWAND: 65,
    FAHRTKOSTEN: 71,
    FAHRTKOSTEN_PRIVATFAHRZEUG: 72,
  },
  LABELS_2025_2026,
);

/** Mapping per tax year. */
export const EUER_LINE_MAPPINGS: Readonly<Record<number, EuerLineMapping>> = {
  2025: ANLAGE_EUER_2025,
  2026: ANLAGE_EUER_2026,
};

/** Whether a line mapping exists for the year (EÜR view hint, #26). */
export function hasLineMapping(year: number): boolean {
  return Object.hasOwn(EUER_LINE_MAPPINGS, year);
}

/**
 * A position with its line and official label in `year`. Without a mapping
 * for the year or the position, only the position is returned (#13); the UI
 * then shows the position's display name.
 */
export type PositionDescription =
  | { readonly position: EuerPosition; readonly line: number; readonly label: string }
  | { readonly position: EuerPosition; readonly line?: undefined; readonly label?: undefined };

export function describePosition(position: EuerPosition, year: number): PositionDescription {
  const entry = hasLineMapping(year) ? EUER_LINE_MAPPINGS[year]?.[position] : undefined;
  return entry ? { position, line: entry.line, label: entry.label } : { position };
}
