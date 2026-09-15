import { rehashEvalFixtures, summarizeRehashResult } from './rehash-fixtures';

const args = process.argv.slice(2);
const check =
  args.length === 1
    ? args[0] === '--check'
    : process.env.npm_config_check === 'true';

if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
  console.error('Usage: npm run eval:rehash -- [--check]');
  process.exit(1);
}

const result = rehashEvalFixtures({ check });
console.log(summarizeRehashResult(result, check));
if (!result.ok) {
  process.exitCode = 1;
}
