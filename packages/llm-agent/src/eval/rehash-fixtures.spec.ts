import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  rehashEvalFixtures,
  type RehashEvalFixturesOptions,
} from './rehash-fixtures';

const CORE_HASH =
  'd1e6e9f24df974e4c75706d8dd4728911b230bb7162cdfe2689ef4b487263835';
const OVERLAY_HASH =
  '5971fc5991ae2b514c4e25cbfaa154aa191b4230c4201e33c00da182209f53fd';

interface FixtureFormatOptions {
  fixtureEol?: string;
  indent?: string;
}

function fixture(coreHash = '0'.repeat(64), promptHash = '1'.repeat(64)) {
  return {
    name: 'sample',
    description: 'fixture for rehash tests',
    coreHash,
    promptFiles: [
      {
        path: 'prompts/chat.system.txt',
        hash: promptHash,
        metadata: { hash: '8'.repeat(64) },
      },
    ],
    metadata: { hash: '9'.repeat(64) },
    userText: 'hello',
    externalUserId: 'eval-sample-0001',
    script: [],
    expected: {},
  };
}

function makeFixtureTree(
  fixtureValue = fixture(),
  fixtureOptions: FixtureFormatOptions = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'wispace-rehash-'));
  const fixturesDir = join(root, 'fixtures');
  mkdirSync(join(root, 'prompts'), { recursive: true });
  mkdirSync(fixturesDir, { recursive: true });
  writeFileSync(join(root, 'prompts/chat.system.txt'), 'overlay\r\n');
  const eol = fixtureOptions.fixtureEol ?? '\r\n';
  const indent = fixtureOptions.indent ?? '    ';
  writeFileSync(
    join(fixturesDir, 'sample.json'),
    `${JSON.stringify(fixtureValue, null, indent).replace(/\n/g, eol)}${eol}`,
  );
  return { root, fixturesDir };
}

function options(
  tree: ReturnType<typeof makeFixtureTree>,
  overrides: Partial<RehashEvalFixturesOptions> = {},
): RehashEvalFixturesOptions {
  return {
    repoRoot: tree.root,
    fixturesDir: tree.fixturesDir,
    corePrompt: 'core\r\n',
    ...overrides,
  };
}

describe('eval fixture rehashing', () => {
  it('updates LF-normalized hashes while preserving fixture formatting and is idempotent', () => {
    const tree = makeFixtureTree();
    try {
      const first = rehashEvalFixtures(options(tree));
      expect(first).toEqual({
        ok: true,
        fixtureCount: 1,
        changed: ['fixtures/sample.json'],
        stale: [],
        errors: [],
      });

      const updated = readFileSync(
        join(tree.fixturesDir, 'sample.json'),
        'utf8',
      );
      expect(updated.endsWith('\r\n')).toBe(true);
      expect(updated.replace(/\r\n/g, '')).not.toContain('\n');
      expect(JSON.parse(updated)).toMatchObject({
        coreHash: CORE_HASH,
        promptFiles: [
          { hash: OVERLAY_HASH, metadata: { hash: '8'.repeat(64) } },
        ],
        metadata: { hash: '9'.repeat(64) },
      });

      const second = rehashEvalFixtures(options(tree));
      expect(second).toEqual({
        ok: true,
        fixtureCount: 1,
        changed: [],
        stale: [],
        errors: [],
      });
      expect(readFileSync(join(tree.fixturesDir, 'sample.json'), 'utf8')).toBe(
        updated,
      );
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });

  it('reports stale hashes in check mode without writing', () => {
    const tree = makeFixtureTree();
    try {
      const before = readFileSync(
        join(tree.fixturesDir, 'sample.json'),
        'utf8',
      );
      const result = rehashEvalFixtures(
        options(tree, { check: true, corePrompt: 'changed\n' }),
      );

      expect(result.ok).toBe(false);
      expect(result.fixtureCount).toBe(1);
      expect(result.changed).toEqual([]);
      expect(result.stale).toEqual(['fixtures/sample.json']);
      expect(result.errors).toEqual([]);
      expect(readFileSync(join(tree.fixturesDir, 'sample.json'), 'utf8')).toBe(
        before,
      );
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });

  it('validates every fixture before writing and rejects repo-escaping prompt paths', () => {
    const tree = makeFixtureTree();
    try {
      const validPath = join(tree.fixturesDir, 'sample.json');
      const before = readFileSync(validPath, 'utf8');
      writeFileSync(
        join(tree.fixturesDir, 'invalid.json'),
        JSON.stringify({
          ...fixture(),
          name: 'invalid',
          promptFiles: [{ path: '../outside.txt', hash: '2'.repeat(64) }],
        }),
      );

      const result = rehashEvalFixtures(options(tree));

      expect(result.ok).toBe(false);
      expect(result.changed).toEqual([]);
      expect(result.stale).toEqual([]);
      expect(result.errors.join('\n')).toContain(
        'invalid.json: prompt path "../outside.txt" escapes the repo root',
      );
      expect(readFileSync(validPath, 'utf8')).toBe(before);
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });

  it('reports invalid JSON and missing prompt files before writing', () => {
    const tree = makeFixtureTree();
    try {
      const validPath = join(tree.fixturesDir, 'sample.json');
      const before = readFileSync(validPath, 'utf8');
      writeFileSync(join(tree.fixturesDir, 'broken.json'), '{not json');
      writeFileSync(
        join(tree.fixturesDir, 'missing.json'),
        JSON.stringify({
          ...fixture(),
          name: 'missing',
          promptFiles: [
            { path: 'prompts/missing.system.txt', hash: '2'.repeat(64) },
          ],
        }),
      );

      const result = rehashEvalFixtures(options(tree));

      expect(result.ok).toBe(false);
      expect(result.changed).toEqual([]);
      expect(result.stale).toEqual([]);
      expect(result.errors.join('\n')).toEqual(
        expect.stringContaining('broken.json: invalid JSON'),
      );
      expect(result.errors.join('\n')).toEqual(
        expect.stringContaining(
          'missing.json: prompt file not found: prompts/missing.system.txt',
        ),
      );
      expect(readFileSync(validPath, 'utf8')).toBe(before);
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });
});
