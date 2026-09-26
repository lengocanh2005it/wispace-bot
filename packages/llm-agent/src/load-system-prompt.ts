import { readFileSync } from 'fs';
import { join } from 'path';

const promptCache = new Map<string, string>();

/**
 * Generic cached loader for `.system.txt` prompt files.
 * Each app owns its prompt directory/files; this loader just reads + caches by absolute path.
 */
export function loadSystemPromptFile(dir: string, fileName: string): string {
  const filePath = join(dir, fileName);
  const cached = promptCache.get(filePath);

  if (cached) {
    return cached;
  }

  const content = readFileSync(filePath, 'utf8').trim();
  promptCache.set(filePath, content);
  return content;
}
