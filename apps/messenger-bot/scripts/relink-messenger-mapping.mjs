import pg from 'pg';

function parseArgs(argv) {
  const args = {
    psid: null,
    userId: null,
    dryRun: false,
  };

  for (const arg of argv) {
    if (arg.startsWith('--psid=')) {
      args.psid = arg.slice('--psid='.length).trim();
    } else if (arg.startsWith('--user-id=')) {
      args.userId = Number(arg.slice('--user-id='.length));
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.psid) {
    throw new Error('--psid is required');
  }

  if (!Number.isFinite(args.userId) || args.userId <= 0) {
    throw new Error('--user-id must be a positive number');
  }

  return args;
}

function printHelp() {
  console.log(`Usage: npm run messenger:relink -- --psid=<PSID> --user-id=<number> [--dry-run]

Ops relink (L3): update user_messenger_mappings.user_id for an existing PSID.
Prefer webhook relink via m.me?ref= when user can open Messenger.

Options:
  --psid=<psid>       Messenger PSID
  --user-id=<number>  New WISPACE user_id
  --dry-run           Show current mapping only
  -h, --help          Show this help
`);
}

const args = parseArgs(process.argv.slice(2));

const pool = new pg.Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl:
    process.env.DB_SSL === 'true'
      ? { rejectUnauthorized: true, ca: process.env.DB_SSL_CA || undefined }
      : undefined,
});

try {
  const current = await pool.query(
    `
      SELECT id, psid, user_id, topic, cadence, status, updated_at
      FROM user_messenger_mappings
      WHERE psid = $1
      ORDER BY id DESC
      LIMIT 1
    `,
    [args.psid],
  );

  if (!current.rows[0]) {
    console.log(JSON.stringify({ found: false, psid: args.psid }, null, 2));
    process.exit(1);
  }

  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          current: current.rows[0],
          targetUserId: args.userId,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  const updated = await pool.query(
    `
      UPDATE user_messenger_mappings
      SET user_id = $2, status = 'ACTIVE', updated_at = now()
      WHERE id = $1
      RETURNING id, psid, user_id, topic, cadence, status, updated_at
    `,
    [current.rows[0].id, args.userId],
  );

  console.log(
    JSON.stringify(
      {
        relinked: current.rows[0].user_id !== args.userId,
        previousUserId: current.rows[0].user_id,
        mapping: updated.rows[0],
        note: 'Call POST /messenger/mapping/relink or open m.me?ref= to sync study reminders + notify user.',
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
