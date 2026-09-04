import { extractQueryRows } from './query-rows.utils';

describe('bot-common/query-rows.utils', () => {
  describe('extractQueryRows', () => {
    it('passes a flat row array through unchanged', () => {
      const rows = [{ id: 1 }, { id: 2 }];
      expect(extractQueryRows(rows)).toEqual(rows);
    });

    it('unwraps the UPDATE/DELETE tuple [rows, rowCount]', () => {
      const rows = [{ id: 1 }];
      expect(extractQueryRows([rows, 1])).toEqual(rows);
    });

    it('unwraps a zero-match tuple [[], 0] to an empty array', () => {
      expect(extractQueryRows([[], 0])).toEqual([]);
    });

    it('returns [] for null/undefined/non-array results', () => {
      expect(extractQueryRows(null)).toEqual([]);
      expect(extractQueryRows(undefined)).toEqual([]);
      expect(extractQueryRows({})).toEqual([]);
    });

    it('treats a length-3 array of arrays as flat rows, not a tuple', () => {
      // A real tuple is always exactly [rows, rowCount:number]; anything
      // longer cannot be a tuple and must stay flat.
      expect(extractQueryRows([[{ id: 1 }], [{ id: 2 }], [{ id: 3 }]])).toEqual(
        [[{ id: 1 }], [{ id: 2 }], [{ id: 3 }]],
      );
    });
  });
});
