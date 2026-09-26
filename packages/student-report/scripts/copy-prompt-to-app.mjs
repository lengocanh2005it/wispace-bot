import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appName = process.argv[2];
if (!['messenger-bot', 'discord-bot', 'zalo-bot'].includes(appName)) {
  throw new Error('Expected messenger-bot, discord-bot, or zalo-bot');
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '../..');
const promptName = 'student-report.system.txt';
const source = join(packageRoot, 'src', 'prompts', promptName);
const outputDir = join(repoRoot, 'apps', appName, 'dist', 'shared', 'prompts');

mkdirSync(outputDir, { recursive: true });
copyFileSync(source, join(outputDir, promptName));
