import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseFixture, runEvalFixture } from './eval-harness';

const FIXTURES_DIR = join(__dirname, '../../fixtures');

function listFixtureFiles(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort();
}

describe('LLM agent eval harness (golden conversations)', () => {
  const fixtureFiles = listFixtureFiles();

  it('discovers at least one fixture', () => {
    expect(fixtureFiles.length).toBeGreaterThan(0);
  });

  for (const file of fixtureFiles) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf8'));
    } catch (error) {
      it(`${file} is valid JSON`, () => {
        throw new Error(
          `fixture is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      continue;
    }
    const parsed = parseFixture(raw);
    if ('errors' in parsed) {
      it(`${file} is a valid fixture`, () => {
        throw new Error(`fixture invalid:\n${parsed.errors.join('\n')}`);
      });
      continue;
    }
    const fixture = parsed.fixture;
    it(`${fixture.name} (${file})`, async () => {
      const result = await runEvalFixture(raw);
      if (!result.ok) {
        throw new Error(
          [
            `summary: ${result.summary}`,
            ...result.failures.map((failure) => `- ${failure}`),
          ].join('\n'),
        );
      }
    }, 30_000);
  }
});
