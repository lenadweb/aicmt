import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from './utils';

export interface GitStatus {
  staged: string[];
  unstaged: string[];
}

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  try {
    return await runCommand('git', args, { cwd });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Git command failed';
    const stderr = (error as { stderr?: string } | undefined)?.stderr ?? '';
    const detail = stderr.trim() || message;
    throw new Error(detail);
  }
}

export async function getRepoRoot(cwd: string): Promise<string> {
  const result = await runGit(['rev-parse', '--show-toplevel'], cwd);
  return result.stdout.trim();
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const result = await runGit(['rev-parse', '--is-inside-work-tree'], cwd);
    return result.stdout.trim() === 'true';
  } catch (error) {
    return false;
  }
}

function extractPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  const arrowIndex = trimmed.indexOf('->');
  if (arrowIndex === -1) {
    return trimmed;
  }

  return trimmed.slice(arrowIndex + 2).trim();
}

function parseStatus(output: string): GitStatus {
  const staged = new Set<string>();
  const unstaged = new Set<string>();

  output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .forEach((line) => {
      if (line.startsWith('??')) {
        const filePath = extractPath(line.slice(2));
        unstaged.add(filePath);
        return;
      }

      const indexStatus = line[0];
      const worktreeStatus = line[1];
      const filePath = extractPath(line.slice(2));

      if (indexStatus && indexStatus !== ' ') {
        staged.add(filePath);
      }

      if (worktreeStatus && worktreeStatus !== ' ') {
        unstaged.add(filePath);
      }
    });

  return {
    staged: Array.from(staged),
    unstaged: Array.from(unstaged),
  };
}

export async function getStatus(repoRoot: string): Promise<GitStatus> {
  const result = await runGit(['status', '--porcelain=v1'], repoRoot);
  return parseStatus(result.stdout);
}

export async function stageAll(repoRoot: string): Promise<void> {
  await runGit(['add', '-A'], repoRoot);
}

export async function getStagedDiff(repoRoot: string): Promise<string> {
  const result = await runGit(['diff', '--cached'], repoRoot);
  return result.stdout;
}

export async function getStagedFiles(repoRoot: string): Promise<string[]> {
  const result = await runGit(['diff', '--cached', '--name-only'], repoRoot);
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function commitWithMessage(repoRoot: string, message: string): Promise<void> {
  if (!message.includes('\n')) {
    await runGit(['commit', '-m', message], repoRoot);
    return;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-committer-'));
  const tempPath = path.join(tempDir, 'commit-message.txt');
  await fs.writeFile(tempPath, message, 'utf8');
  try {
    await runGit(['commit', '-F', tempPath], repoRoot);
  } finally {
    try {
      await fs.unlink(tempPath);
    } catch (error) {
      // Ignore cleanup errors.
    }
  }
}
