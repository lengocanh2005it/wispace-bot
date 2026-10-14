import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { checkRedisUsage } from './check-redis-usage.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wispace-redis-usage-'));
  const write = (relativePath, source) => {
    const file = join(root, relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
  };
  for (const packageName of [
    'bot-common',
    'chat-history',
    'chat-agent',
    'chat-metering',
    'llm-agent',
    'wispace-client',
  ]) {
    write(`packages/${packageName}/src/index.ts`, 'export {};\n');
  }
  write(
    'packages/bot-common/src/redis/redis.service.ts',
    'class DeadlineRedis {}\nconst client = new DeadlineRedis();\n',
  );
  return {
    root,
    write,
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('the current repository satisfies the shared Redis connection invariant', () => {
  const result = checkRedisUsage(ROOT);
  assert.deepEqual(result.violations, []);
  assert.ok(result.filesScanned > 0);
});

test('blocking command methods and blocking stream reads are rejected', () => {
  const f = fixture();
  try {
    f.write(
      'packages/chat-agent/src/redis-consumer.ts',
      [
        "redis.blpop('queue', 0);",
        "redis.brpop('queue', 0);",
        "redis.brpoplpush('source', 'target', 0);",
        "redis.blmove('source', 'target', 'LEFT', 'RIGHT', 0);",
        "redis.bzpopmin('sorted', 0);",
        "redis.bzpopmax('sorted', 0);",
        "redis.bzmpop(0, 1, 'sorted', 'MIN');",
        "redis.xread('BLOCK', 0, 'STREAMS', 'events', '$');",
        "redis.xreadgroup('GROUP', 'group', 'consumer', 'BLOCK', 0, 'STREAMS', 'events', '>');",
        "redis.subscribe('events');",
        "redis.psubscribe('events:*');",
        "redis.call('XREADGROUP', 'GROUP', 'group', 'consumer', 'BLOCK', 0);",
      ].join('\n'),
    );

    const result = checkRedisUsage(f.root);

    const blocking = result.violations.filter(
      (violation) => violation.rule === 'redis-blocking-command',
    );
    assert.equal(blocking.length, 12);
    assert.ok(
      blocking.some((violation) => violation.evidence === 'XREADGROUP BLOCK'),
    );
  } finally {
    f.close();
  }
});

test('extra clients and duplicated connections are rejected', () => {
  const f = fixture();
  try {
    f.write(
      'packages/chat-history/src/redis-consumer.ts',
      [
        "import Redis from 'ioredis';",
        "import { Cluster as RedisCluster } from 'ioredis';",
        "import CustomRedis from 'ioredis';",
        'const first = new Redis();',
        'const second = new RedisCluster([]);',
        'const third = new CustomRedis();',
        'const fourth = client.duplicate();',
      ].join('\n'),
    );

    const result = checkRedisUsage(f.root);

    const connections = result.violations.filter(
      (violation) => violation.rule === 'redis-extra-connection',
    );
    assert.equal(connections.length, 4);
    assert.ok(
      connections.some((violation) => violation.evidence === 'new Redis('),
    );
    assert.ok(
      connections.some(
        (violation) => violation.evidence === 'new RedisCluster(',
      ),
    );
    assert.ok(
      connections.some(
        (violation) => violation.evidence === 'new CustomRedis(',
      ),
    );
    assert.ok(
      connections.some((violation) => violation.evidence === '.duplicate('),
    );
  } finally {
    f.close();
  }
});

test('commented examples do not trip the command guard', () => {
  const f = fixture();
  try {
    f.write(
      'packages/chat-metering/src/redis-consumer.ts',
      [
        '// redis.blpop("queue", 0);',
        "/* redis.call('BLPOP', 'queue', 0); */",
        'export const useRedis = (redis) => redis.get("key");',
      ].join('\n'),
    );

    assert.deepEqual(checkRedisUsage(f.root).violations, []);
  } finally {
    f.close();
  }
});
