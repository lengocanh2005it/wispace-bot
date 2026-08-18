import pg from 'pg';
import { parseArgs } from './_args.mjs';

const HELP = `Usage: npm run llm-usage:status -- [options]

Options:
  --psid=<psid>           Filter by Messenger PSID
  --user-id=<number>      Filter by WISPACE user_id
  --date=YYYY-MM-DD       Usage date (LLM_USAGE_TIMEZONE). Default: today
  --feature=<name>        FREE_FORM_CHAT | STUDENT_REPORT | STUDY_REMINDER
  --ops                   Fleet-wide summary by feature
  -h, --help              Show this help
`;

function todayUsageDate(timezone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    defaults: {
      psid: null,
      userId: null,
      date: null,
      feature: null,
      ops: false,
    },
    help: HELP,
    handle: (a, arg) => {
      if (arg.startsWith('--psid=')) {
        a.psid = arg.slice('--psid='.length).trim();
        return true;
      }
      if (arg.startsWith('--user-id=')) {
        const value = Number(arg.slice('--user-id='.length));
        if (!Number.isFinite(value)) {
          throw new Error('--user-id must be a number');
        }
        a.userId = value;
        return true;
      }
      if (arg.startsWith('--date=')) {
        a.date = arg.slice('--date='.length).trim();
        return true;
      }
      if (arg.startsWith('--feature=')) {
        a.feature = arg.slice('--feature='.length).trim();
        return true;
      }
      if (arg === '--ops') {
        a.ops = true;
        return true;
      }
      return false;
    },
  });
  const timezone = process.env.LLM_USAGE_TIMEZONE?.trim() ?? 'Asia/Ho_Chi_Minh';
  const usageDate = args.date ?? todayUsageDate(timezone);

  const client = new pg.Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl:
      process.env.DB_SSL === 'true'
        ? { rejectUnauthorized: true, ca: process.env.DB_SSL_CA || undefined }
        : false,
  });

  await client.connect();

  try {
    if (args.ops) {
      const summary = await client.query(
        `
          SELECT
            feature,
            COUNT(*)::int AS calls,
            COALESCE(SUM(prompt_tokens), 0)::int AS prompt_tokens,
            COALESCE(SUM(completion_tokens), 0)::int AS completion_tokens,
            COALESCE(SUM(total_tokens), 0)::int AS total_tokens,
            COALESCE(SUM(estimated_cost_usd), 0)::text AS estimated_cost_usd
          FROM llm_usage_events
          WHERE usage_date = $1::date
          GROUP BY feature
          ORDER BY feature
        `,
        [usageDate],
      );

      console.log(
        `LLM usage ops summary date=${usageDate} timezone=${timezone}`,
      );
      if (summary.rows.length === 0) {
        console.log('  (no rows)');
      } else {
        for (const row of summary.rows) {
          const usd =
            Number(row.estimated_cost_usd) > 0
              ? ` usd=${row.estimated_cost_usd}`
              : '';
          console.log(
            `  ${row.feature}: calls=${row.calls} prompt=${row.prompt_tokens} completion=${row.completion_tokens} total=${row.total_tokens}${usd}`,
          );
        }
      }

      return;
    }

    const filters = ['usage_date = $1::date'];
    const params = [usageDate];
    let paramIndex = 2;

    if (args.psid) {
      filters.push(`psid = $${paramIndex}`);
      params.push(args.psid);
      paramIndex += 1;
    }

    if (args.userId !== null) {
      filters.push(`user_id = $${paramIndex}`);
      params.push(args.userId);
      paramIndex += 1;
    }

    if (args.feature) {
      filters.push(`feature = $${paramIndex}`);
      params.push(args.feature);
      paramIndex += 1;
    }

    const rows = await client.query(
      `
        SELECT
          feature,
          psid,
          user_id,
          model,
          prompt_tokens,
          completion_tokens,
          total_tokens,
          estimated_cost_usd,
          correlation_id,
          tool_round,
          occurred_at
        FROM llm_usage_events
        WHERE ${filters.join(' AND ')}
        ORDER BY occurred_at DESC
        LIMIT 50
      `,
      params,
    );

    console.log(
      `LLM usage status date=${usageDate} rows=${rows.rows.length} (max 50)`,
    );
    for (const row of rows.rows) {
      console.log(
        JSON.stringify({
          feature: row.feature,
          psid: row.psid,
          userId: row.user_id,
          model: row.model,
          promptTokens: row.prompt_tokens,
          completionTokens: row.completion_tokens,
          totalTokens: row.total_tokens,
          estimatedCostUsd: row.estimated_cost_usd,
          correlationId: row.correlation_id,
          toolRound: row.tool_round,
          occurredAt: row.occurred_at,
        }),
      );
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
