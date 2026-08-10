/**
 * Ops tool for messenger_webhook_dead_letters.
 *
 * Usage:
 *   npm run webhook:dead-letter -- --list
 *   npm run webhook:dead-letter -- --replay [--base-url=http://localhost:3000] [--limit=10]
 *   npm run webhook:dead-letter -- --abandon --id=42
 *   npm run webhook:dead-letter -- --stats
 */

import { createPool } from './_db.mjs';
import { parseArgs, printHelp } from './_args.mjs';

const DEFAULT_BASE_URL = 'http://localhost:3000';
const DEFAULT_LIMIT = 20;

const HELP = `Usage: npm run webhook:dead-letter -- <command> [options]

Commands:
  --list              Show pending dead-letter entries
  --stats             Count entries by status
  --replay            Replay pending entries by POSTing to the webhook endpoint
  --abandon --id=N    Mark a specific entry as abandoned (give up on replay)

Options:
  --limit=N           Max entries to process (default: ${DEFAULT_LIMIT})
  --base-url=URL      Webhook base URL for replay (default: ${DEFAULT_BASE_URL})
  -h, --help          Show this help

Examples:
  npm run webhook:dead-letter -- --stats
  npm run webhook:dead-letter -- --list
  npm run webhook:dead-letter -- --replay --limit=5
  npm run webhook:dead-letter -- --replay --base-url=https://api.myapp.com
  npm run webhook:dead-letter -- --abandon --id=42
`;

async function cmdStats(pool) {
  const { rows } = await pool.query(`
    SELECT status, COUNT(*)::int AS count
    FROM messenger_webhook_dead_letters
    GROUP BY status
    ORDER BY status
  `);

  if (rows.length === 0) {
    console.log('No dead-letter entries found.');
    return;
  }

  console.log('Dead-letter status counts:');
  for (const row of rows) {
    console.log(`  ${row.status.padEnd(10)} ${row.count}`);
  }
}

async function cmdList(pool, limit) {
  const { rows } = await pool.query(
    `SELECT id, psid, message_mid, error_message, retry_count, status, created_at
     FROM messenger_webhook_dead_letters
     WHERE status = 'pending'
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit],
  );

  if (rows.length === 0) {
    console.log('No pending dead-letter entries.');
    return;
  }

  console.log(`Pending dead-letter entries (up to ${limit}):\n`);
  for (const row of rows) {
    console.log(
      `  id=${row.id}  psid=${row.psid ?? 'n/a'}  mid=${row.message_mid ?? 'n/a'}` +
        `  retries=${row.retry_count}  created=${row.created_at.toISOString()}`,
    );
    console.log(`    error: ${row.error_message}`);
  }
  console.log(`\nTotal: ${rows.length}`);
}

async function cmdReplay(pool, limit, baseUrl) {
  const webhookUrl = `${baseUrl}/messenger/webhook`;
  const internalApiKey = process.env.INTERNAL_API_KEY;

  const { rows } = await pool.query(
    `SELECT id, psid, raw_payload, retry_count
     FROM messenger_webhook_dead_letters
     WHERE status = 'pending'
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit],
  );

  if (rows.length === 0) {
    console.log('No pending dead-letter entries to replay.');
    return;
  }

  console.log(`Replaying ${rows.length} entry(s) → ${webhookUrl}\n`);

  let replayed = 0;
  let failed = 0;

  for (const row of rows) {
    const payload = {
      object: 'page',
      entry: [{ messaging: [row.raw_payload] }],
    };

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (internalApiKey) {
        headers['X-Internal-Api-Key'] = internalApiKey;
      }

      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body}`);
      }

      const result = await res.json();
      const eventFailed = result?.failures?.length > 0;

      if (eventFailed) {
        const errMsg = result.failures[0]?.error ?? 'unknown error';
        await pool.query(
          `UPDATE messenger_webhook_dead_letters
           SET retry_count = retry_count + 1,
               error_message = $2,
               updated_at = now()
           WHERE id = $1`,
          [row.id, errMsg],
        );
        console.log(
          `  [FAIL] id=${row.id} psid=${row.psid ?? 'n/a'}: ${errMsg}`,
        );
        failed += 1;
      } else {
        await pool.query(
          `UPDATE messenger_webhook_dead_letters
           SET status = 'replayed', replayed_at = now(), updated_at = now()
           WHERE id = $1`,
          [row.id],
        );
        console.log(`  [OK]   id=${row.id} psid=${row.psid ?? 'n/a'}`);
        replayed += 1;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await pool.query(
        `UPDATE messenger_webhook_dead_letters
         SET retry_count = retry_count + 1,
             error_message = $2,
             updated_at = now()
         WHERE id = $1`,
        [row.id, errMsg],
      );
      console.log(`  [ERR]  id=${row.id} psid=${row.psid ?? 'n/a'}: ${errMsg}`);
      failed += 1;
    }
  }

  console.log(`\nDone: replayed=${replayed}, failed=${failed}`);
}

async function cmdAbandon(pool, id) {
  if (!id || !Number.isFinite(id)) {
    console.error('--id=N required for --abandon');
    process.exit(1);
  }

  const { rowCount } = await pool.query(
    `UPDATE messenger_webhook_dead_letters
     SET status = 'abandoned', updated_at = now()
     WHERE id = $1 AND status = 'pending'`,
    [id],
  );

  if (rowCount === 0) {
    console.log(`Entry id=${id} not found or not in pending status.`);
  } else {
    console.log(`Entry id=${id} marked as abandoned.`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    defaults: {
      command: null,
      id: null,
      limit: DEFAULT_LIMIT,
      baseUrl: DEFAULT_BASE_URL,
    },
    help: HELP,
    handle: (a, arg) => {
      if (arg === '--list') {
        a.command = 'list';
        return true;
      }
      if (arg === '--replay') {
        a.command = 'replay';
        return true;
      }
      if (arg === '--stats') {
        a.command = 'stats';
        return true;
      }
      if (arg === '--abandon') {
        a.command = 'abandon';
        return true;
      }
      if (arg.startsWith('--id=')) {
        a.id = Number(arg.slice('--id='.length));
        return true;
      }
      if (arg.startsWith('--limit=')) {
        a.limit = Number(arg.slice('--limit='.length));
        return true;
      }
      if (arg.startsWith('--base-url=')) {
        a.baseUrl = arg.slice('--base-url='.length).trim();
        return true;
      }
      return false;
    },
  });

  if (!args.command) {
    printHelp(HELP);
    process.exit(1);
  }

  const pool = createPool();

  try {
    if (args.command === 'stats') {
      await cmdStats(pool);
    } else if (args.command === 'list') {
      await cmdList(pool, args.limit);
    } else if (args.command === 'replay') {
      await cmdReplay(pool, args.limit, args.baseUrl);
    } else if (args.command === 'abandon') {
      await cmdAbandon(pool, args.id);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
