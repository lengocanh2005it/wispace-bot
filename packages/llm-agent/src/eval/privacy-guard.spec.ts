import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const FIXTURES_DIR = join(__dirname, '../../fixtures');

/**
 * Privacy guard for eval fixtures — repo log-redaction policy applies to
 * golden transcripts too: never commit real external IDs (PSID, Discord ID,
 * Zalo ID, WISPACE userId) or any long numeric identifier.
 */
describe('eval fixture privacy guard', () => {
  const files = readdirSync(FIXTURES_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort();

  it('discovers at least one fixture', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} uses fake identifiers and no long numeric ids`, () => {
      const raw = readFileSync(join(FIXTURES_DIR, file), 'utf8');
      const parsed = JSON.parse(raw) as { externalUserId?: unknown };

      expect(parsed.externalUserId).toBeDefined();
      expect(String(parsed.externalUserId)).toMatch(/^eval-/);

      // Long digit runs look like real platform ids (PSID/Zalo uid) — a
      // 15+ digit sequence in any fixture field is treated as a leak.
      expect(raw).not.toMatch(/\d{15,}/);
    });
  }
});
