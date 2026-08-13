import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Zalo runtime dependencies', () => {
  it('declares the report package as a runtime dependency', () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '../package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };

    expect(packageJson.dependencies?.['@wispace/student-report']).toBe('*');
  });
});
