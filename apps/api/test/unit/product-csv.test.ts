import { describe, expect, it } from 'vitest';
import {
  parseCsv,
  sanitizeCsvCell,
  toCsv,
} from '../../src/modules/products/import-export/product-csv';

/**
 * Unit coverage for the export CSV codec, focused on spreadsheet formula-injection
 * hardening (`sanitizeCsvCell` / `toCsv`). Hermetic — no database, no booted app.
 */
describe('CSV export formula-injection sanitizer', () => {
  describe('sanitizeCsvCell', () => {
    it('neutralizes the formula-trigger leads = + - @ with a literal quote prefix', () => {
      expect(sanitizeCsvCell('=cmd|/C calc')).toBe("'=cmd|/C calc");
      expect(sanitizeCsvCell('+SUM(A1:A2)')).toBe("'+SUM(A1:A2)");
      expect(sanitizeCsvCell('-10+20')).toBe("'-10+20");
      expect(sanitizeCsvCell('@HYPERLINK(evil)')).toBe("'@HYPERLINK(evil)");
    });

    it('neutralizes control-whitespace leads (tab, CR, LF)', () => {
      expect(sanitizeCsvCell('\t=1')).toBe("'\t=1");
      expect(sanitizeCsvCell('\r=1')).toBe("'\r=1");
      expect(sanitizeCsvCell('\n=1')).toBe("'\n=1");
    });

    it('neutralizes a formula hidden behind leading spaces (Excel trims them)', () => {
      expect(sanitizeCsvCell('   =1+1')).toBe("'   =1+1");
      expect(sanitizeCsvCell(' @cmd')).toBe("' @cmd");
    });

    it('leaves ordinary values unchanged (no false positives)', () => {
      for (const safe of ['SKU-001', 'Product Name', 'A normal description.', '', 'TRY', '1000']) {
        expect(sanitizeCsvCell(safe)).toBe(safe);
      }
    });

    it('does not treat a non-leading trigger char as risky', () => {
      expect(sanitizeCsvCell('A=B')).toBe('A=B');
      expect(sanitizeCsvCell('user@host')).toBe('user@host');
    });
  });

  describe('toCsv applies the guard centrally', () => {
    it('serializes formula cells as inert literals while keeping safe cells raw', () => {
      const out = toCsv(
        ['sku', 'name'],
        [
          ['=cmd', 'Safe Name'],
          ['SKU-001', '+evil'],
        ],
      );
      const [, row1, row2] = out.split('\r\n');
      expect(row1).toBe("'=cmd,Safe Name");
      expect(row2).toBe("SKU-001,'+evil");
    });

    it('still quotes commas/quotes/newlines, and quoting wraps the neutralized value', () => {
      const out = toCsv(['name'], [['Foo, Bar'], ['=Foo, "Bar"']]);
      const lines = out.split('\r\n');
      expect(lines[1]).toBe('"Foo, Bar"');
      expect(lines[2]).toBe('"\'=Foo, ""Bar"""');
    });
  });

  describe('round-trip does not re-arm a neutralized cell', () => {
    it('the import parser reads a sanitized cell as literal data, not a formula', () => {
      const out = toCsv(['name'], [['=danger']]);
      const parsed = parseCsv(out);
      // The exported byte is the inert literal; re-reading yields "'=danger".
      expect(parsed.rows[0]?.[0]).toBe("'=danger");
    });
  });
});
