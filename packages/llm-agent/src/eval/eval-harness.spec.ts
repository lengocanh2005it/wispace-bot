import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseFixture, runEvalFixture } from './eval-harness';

const FIXTURES_DIR = join(__dirname, '../../fixtures');

describe('eval fixture tiers', () => {
  const fixture = JSON.parse(
    readFileSync(join(FIXTURES_DIR, 'greeting.json'), 'utf8'),
  ) as Record<string, unknown>;

  it('accepts must-allow as an explicit tier', () => {
    const parsed = parseFixture({ ...fixture, tier: 'must-allow' });

    expect('errors' in parsed).toBe(false);
    if (!('errors' in parsed)) {
      expect(parsed.fixture.tier).toBe('must-allow');
    }
  });

  it('keeps an undeclared tier at the fail-safe must-block default', () => {
    const { tier: _tier, ...undeclared } = fixture;
    const parsed = parseFixture(undeclared);

    expect('errors' in parsed).toBe(false);
    if (!('errors' in parsed)) {
      expect(parsed.fixture.tier).toBe('must-block');
    }
  });

  it('rejects unsupported explicit tiers', () => {
    const parsed = parseFixture({ ...fixture, tier: 'best-effort' });

    expect(parsed).toEqual({
      errors: [
        'tier must be "must-block", "adversarial", or "must-allow" (#635/#1029)',
      ],
    });
  });
});

function listFixtureFiles(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort();
}

describe('LLM agent eval harness (offline orchestration regression)', () => {
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
