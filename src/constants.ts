import path from 'node:path';

export const CONFIG_FILENAME = 'ai-committer.json';
export const DEFAULT_MODEL = 'openai/gpt-4o-mini';
export const DEFAULT_TEMPERATURE = 0.2;
export const DEFAULT_MAX_TOKENS = 120;
export function getDefaultConfigPath(repoRoot: string): string {
  return path.join(repoRoot, CONFIG_FILENAME);
}
