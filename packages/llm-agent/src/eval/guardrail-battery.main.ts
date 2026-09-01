/**
 * #635 CI entry: run the combined guardrail battery over the fixtures dir
 * and exit non-zero when the pass bar is violated. Lives as a compiled
 * entry so `npm run eval:guardrail` needs no extra tooling.
 */
import { join } from 'path';
import {
  runGuardrailBatteryFromDir,
  summarizeBattery,
} from './guardrail-battery';

const FIXTURES_DIR = join(__dirname, '../../fixtures');

runGuardrailBatteryFromDir(FIXTURES_DIR)
  .then((outcome) => {
    console.log(summarizeBattery(outcome));
    if (!outcome.ok) {
      process.exit(1);
    }
  })
  .catch((error) => {
    console.error(
      `guardrail battery failed to run: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
