import { createPool } from './_db.mjs';
import { parseArgs } from './_args.mjs';
import { maskExternalId } from '@wispace/bot-common/masking';

function maskMapping(row) {
  if (!row) return row;
  return {
    ...row,
    psid: maskExternalId(row.psid),
    user_id: maskExternalId(row.user_id),
  };
}

const HELP = `Usage: npm run messenger:relink -- --psid=<PSID> --user-id=<number> [--dry-run]

Ops relink (L3): update user_messenger_mappings.user_id for an existing PSID.
Prefer webhook relink via m.me?ref= when user can open Messenger.

Options:
  --psid=<psid>       Messenger PSID
  --user-id=<number>  New WISPACE user_id
  --dry-run           Show current mapping only
  -h, --help          Show this help
`;

const args = parseArgs(process.argv.slice(2), {
  defaults: { psid: null, userId: null, dryRun: false },
  help: HELP,
  handle: (a, arg) => {
    if (arg.startsWith('--psid=')) {
      a.psid = arg.slice('--psid='.length).trim();
      return true;
    }
    if (arg.startsWith('--user-id=')) {
      a.userId = Number(arg.slice('--user-id='.length));
      return true;
    }
    if (arg === '--dry-run') {
      a.dryRun = true;
      return true;
    }
    return false;
  },
});

if (!args.psid) {
  throw new Error('--psid is required');
}

if (!Number.isFinite(args.userId) || args.userId <= 0) {
  throw new Error('--user-id must be a positive number');
}

const pool = createPool();

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
    console.log(
      JSON.stringify(
        { found: false, psid: maskExternalId(args.psid) },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          current: maskMapping(current.rows[0]),
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
        previousUserId: maskExternalId(current.rows[0].user_id),
        mapping: maskMapping(updated.rows[0]),
        note: 'Call POST /messenger/mapping/relink or open m.me?ref= to sync study reminders + notify user.',
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
