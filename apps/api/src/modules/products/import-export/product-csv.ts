/**
 * Minimal, dependency-free CSV reader/writer for the Product Import/Export
 * Foundation.
 *
 * The repo has no spreadsheet library wired up and no durable blob storage, so
 * this slice ships a self-contained, RFC 4180-style CSV codec (quoted fields,
 * embedded commas/newlines, doubled `""` escapes, CRLF or LF, optional UTF-8
 * BOM). XLSX is intentionally out of scope here — see the task report. Keeping
 * the parser tiny and explicit avoids pulling an unvetted dependency into the
 * request path and keeps every byte the importer trusts visible.
 */

/** A parsed CSV document: the header cells plus each data row's cells. */
export interface ParsedCsv {
  header: string[];
  /** Data rows (header excluded). Each is the raw cell array for that line. */
  rows: string[][];
}

/** Thrown when the bytes are not well-formed CSV (unterminated quote, etc.). */
export class CsvParseError extends Error {}

/** Strip a leading UTF-8 BOM if present (Excel writes one). */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Parse CSV text into a header + data rows. Empty trailing lines are ignored.
 * A completely empty document (no header) throws — callers treat that as a 400.
 */
export function parseCsv(input: string): ParsedCsv {
  const text = stripBom(input);
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let sawAnyChar = false;

  const pushField = (): void => {
    record.push(field);
    field = '';
  };
  const pushRecord = (): void => {
    pushField();
    records.push(record);
    record = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    sawAnyChar = true;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      pushField();
    } else if (ch === '\n') {
      pushRecord();
    } else if (ch === '\r') {
      // Swallow CR; the following LF (if any) closes the record.
      if (text[i + 1] === '\n') {
        i += 1;
      }
      pushRecord();
    } else {
      field += ch;
    }
  }
  if (inQuotes) throw new CsvParseError('Unterminated quoted field');
  // Flush the final record unless the file ended exactly on a newline.
  if (field !== '' || record.length > 0) pushRecord();

  if (!sawAnyChar || records.length === 0) {
    throw new CsvParseError('The file is empty');
  }

  const [header, ...rest] = records;
  // Drop blank trailing lines (a single empty cell and nothing else).
  const rows = rest.filter((r) => !(r.length === 1 && r[0] === ''));
  return { header: header as string[], rows };
}

/**
 * A cell is treated as formula-injection risk when, after any leading spaces, it
 * begins with a character a spreadsheet may interpret as a formula/command:
 * `=`, `+`, `-`, `@`, or a control whitespace (tab / CR / LF). Leading spaces are
 * matched explicitly because Excel/LibreOffice trim them before parsing a
 * formula. Tab/CR/LF are themselves dangerous leads, so they are listed in the
 * trigger class rather than skipped as whitespace.
 */
const FORMULA_INJECTION_LEAD = /^ *[=+\-@\t\r\n]/;

/**
 * Neutralise a cell that a spreadsheet could execute as a formula/command (CSV
 * "formula injection" / DDE). The value's data is preserved verbatim; a single
 * quote is prepended so Excel/LibreOffice/Google Sheets render it as a literal
 * text cell instead of evaluating it. Safe cells are returned unchanged.
 *
 * This is an EXPORT-only concern: it shapes the bytes we hand to a spreadsheet.
 * The import parser never calls this — re-importing keeps treating cells as data.
 */
export function sanitizeCsvCell(value: string): string {
  return FORMULA_INJECTION_LEAD.test(value) ? `'${value}` : value;
}

/** Quote a single cell when it contains a comma, quote, or newline. */
function encodeCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Serialise a header + rows to CSV text (CRLF line endings, the Excel-friendly
 * default). Values are coerced to string; null/undefined become an empty cell.
 *
 * Every cell is run through {@link sanitizeCsvCell} first so a product field that
 * looks like a spreadsheet formula (e.g. a SKU of `=cmd|...`) is exported as inert
 * literal text — this writer is the single export sink, so the guard is central.
 */
export function toCsv(
  header: string[],
  rows: Array<Array<string | number | null | undefined>>,
): string {
  const encode = (value: string): string => encodeCell(sanitizeCsvCell(value));
  const lines: string[] = [];
  lines.push(header.map(encode).join(','));
  for (const row of rows) {
    lines.push(row.map((c) => encode(c == null ? '' : String(c))).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
