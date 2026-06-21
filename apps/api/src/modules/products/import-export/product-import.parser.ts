import type { ProductImportErrorView } from '@b2b/contracts';
import { isBigIntStringInRange } from '../../../common/validation/is-bigint-string.decorator';
import type { ParsedCsv } from './product-csv';

/** A fully validated import row, ready to be written as a product. */
export interface ValidatedImportRow {
  sku: string;
  name: string;
  description: string | null;
  currency: string;
  listPriceAmount: bigint;
  taxRateBp: number;
  criticalStockThreshold: bigint | null;
  isActive: boolean;
}

/** Required columns — the import is rejected (400) if any is missing. */
export const REQUIRED_COLUMNS = [
  'sku',
  'name',
  'currency',
  'listPriceAmount',
  'taxRateBp',
] as const;
/** Optional columns — accepted when present, defaulted when absent. */
export const OPTIONAL_COLUMNS = ['description', 'criticalStockThreshold', 'isActive'] as const;
const ALLOWED_COLUMNS = new Set<string>([...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]);

/** A structural problem with the file header (→ 400, before any row is read). */
export class ImportHeaderError extends Error {}

const MAX_NAME = 255;
const MAX_SKU = 64;
const MAX_DESCRIPTION = 2000;
const MAX_TAX_RATE_BP = 10000;
const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * Validate the CSV header. Throws {@link ImportHeaderError} (→ 400) when a
 * required column is missing, an unknown column is present (a forged `companyId`
 * column is rejected here — a tenant can never be supplied by the client), or a
 * column is duplicated. Returns the column→index map for row extraction.
 */
export function validateHeader(header: string[]): Map<string, number> {
  const index = new Map<string, number>();
  header.forEach((raw, i) => {
    const col = raw.trim();
    if (col === '') return;
    if (col === 'companyId' || col === 'company_id') {
      throw new ImportHeaderError(
        'The "companyId" column is not allowed — products are always imported into your own company.',
      );
    }
    if (!ALLOWED_COLUMNS.has(col)) {
      throw new ImportHeaderError(`Unknown column "${col}".`);
    }
    if (index.has(col)) {
      throw new ImportHeaderError(`Duplicate column "${col}".`);
    }
    index.set(col, i);
  });
  const missing = REQUIRED_COLUMNS.filter((c) => !index.has(c));
  if (missing.length > 0) {
    throw new ImportHeaderError(`Missing required column(s): ${missing.join(', ')}.`);
  }
  return index;
}

/** Result of validating every data row: either all rows are valid, or a list of errors. */
export interface RowValidationResult {
  rows: ValidatedImportRow[];
  errors: ProductImportErrorView[];
}

/**
 * Validate every data row against the column rules. Errors are accumulated with
 * a 1-based row number (the header is row 0) and the offending column, so the
 * caller can report a precise per-row failure list. Duplicate SKUs — both within
 * the file and against `existingSkus` (active products already in the company) —
 * are flagged as row errors so the all-or-nothing apply never partially writes.
 *
 * Bigint-bound fields (`listPriceAmount`, `criticalStockThreshold`) are range
 * checked here at the boundary, so an over-range value is a clean validation
 * error (→ 422), never a PostgreSQL overflow 500.
 */
export function validateRows(
  parsed: ParsedCsv,
  columns: Map<string, number>,
  existingSkus: ReadonlySet<string>,
): RowValidationResult {
  const rows: ValidatedImportRow[] = [];
  const errors: ProblemRow[] = [];
  const seenInFile = new Set<string>();

  const cell = (row: string[], col: string): string => {
    const i = columns.get(col);
    if (i === undefined) return '';
    return (row[i] ?? '').trim();
  };

  parsed.rows.forEach((raw, idx) => {
    const rowNo = idx + 1;
    const add = (column: string | null, message: string): void => {
      errors.push({ row: rowNo, column, message });
    };

    const sku = cell(raw, 'sku');
    const name = cell(raw, 'name');
    const currency = cell(raw, 'currency');
    const priceRaw = cell(raw, 'listPriceAmount');
    const taxRaw = cell(raw, 'taxRateBp');
    const descRaw = cell(raw, 'description');
    const thresholdRaw = cell(raw, 'criticalStockThreshold');
    const activeRaw = cell(raw, 'isActive');

    let ok = true;

    if (sku.length < 1 || sku.length > MAX_SKU) {
      add('sku', `sku must be 1..${MAX_SKU} characters.`);
      ok = false;
    } else if (seenInFile.has(sku)) {
      add('sku', `Duplicate SKU "${sku}" within the file.`);
      ok = false;
    } else if (existingSkus.has(sku)) {
      add('sku', `SKU "${sku}" already exists in this company.`);
      ok = false;
    }
    seenInFile.add(sku);

    if (name.length < 1 || name.length > MAX_NAME) {
      add('name', `name must be 1..${MAX_NAME} characters.`);
      ok = false;
    }

    if (!CURRENCY_RE.test(currency)) {
      add('currency', 'currency must be a 3-letter ISO code (e.g. TRY).');
      ok = false;
    }

    if (!isBigIntStringInRange(priceRaw)) {
      add('listPriceAmount', 'listPriceAmount must be a non-negative integer within bigint range.');
      ok = false;
    }

    const tax = Number(taxRaw);
    if (!/^\d+$/.test(taxRaw) || !Number.isInteger(tax) || tax < 0 || tax > MAX_TAX_RATE_BP) {
      add('taxRateBp', `taxRateBp must be an integer 0..${MAX_TAX_RATE_BP}.`);
      ok = false;
    }

    if (descRaw.length > MAX_DESCRIPTION) {
      add('description', `description must be at most ${MAX_DESCRIPTION} characters.`);
      ok = false;
    }

    let threshold: bigint | null = null;
    if (thresholdRaw !== '') {
      if (!isBigIntStringInRange(thresholdRaw)) {
        add(
          'criticalStockThreshold',
          'criticalStockThreshold must be a non-negative integer within bigint range.',
        );
        ok = false;
      } else {
        threshold = BigInt(thresholdRaw);
      }
    }

    let isActive = true;
    if (activeRaw !== '') {
      if (activeRaw === 'true') isActive = true;
      else if (activeRaw === 'false') isActive = false;
      else {
        add('isActive', 'isActive must be "true" or "false".');
        ok = false;
      }
    }

    if (ok) {
      rows.push({
        sku,
        name,
        description: descRaw === '' ? null : descRaw,
        currency,
        listPriceAmount: BigInt(priceRaw),
        taxRateBp: tax,
        criticalStockThreshold: threshold,
        isActive,
      });
    }
  });

  return { rows, errors };
}

type ProblemRow = ProductImportErrorView;
