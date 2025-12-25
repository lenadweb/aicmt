import path from 'node:path';
import { readFileIfExists, writeFileSafe } from './fs';

export async function ensureGitignoreEntry(
  repoRoot: string,
  targetPath: string,
): Promise<boolean> {
  const relative = path.relative(repoRoot, targetPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }

  const normalized = relative.replace(/\\/g, '/');
  const gitignorePath = path.join(repoRoot, '.gitignore');
  const existing = await readFileIfExists(gitignorePath);

  if (existing && existing.split('\n').some((line) => line.trim() === normalized)) {
    return false;
  }

  const prefix = existing && existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  const updated = `${existing ?? ''}${prefix}${normalized}\n`;
  await writeFileSafe(gitignorePath, updated);
  return true;
}
