import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from './utils';

export interface GitStatus {
  staged: string[];
  unstaged: string[];
}

export interface DiffHunk {
  id: string;           // unique identifier: "file:hunkIndex"
  file: string;         // file path
  hunkIndex: number;    // hunk index within the file (0 = whole-file change without text hunks)
  wholeFile: boolean;   // binary, mode-only or empty-file change: staged as a whole file
  content: string[];    // lines of the hunk (including @@ line)
  fileHeader: string[]; // diff --git, index, ---, +++ lines
  summary: string;      // first few changed lines for AI context
}

async function runGit(
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  try {
    // core.quotePath=false keeps non-ASCII paths readable and identical across status/diff/add
    return await runCommand('git', ['-c', 'core.quotePath=false', ...args], {
      cwd,
      env: env ? { ...process.env, ...env } : undefined,
    });
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

function parseStatus(output: string): GitStatus {
  const staged = new Set<string>();
  const unstaged = new Set<string>();

  // Porcelain v1 with -z: "XY path\0", renames/copies add "origPath\0" after the new path
  const entries = output.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) {
      continue;
    }

    const indexStatus = entry[0];
    const worktreeStatus = entry[1];
    const filePath = entry.slice(3);

    if (indexStatus === 'R' || indexStatus === 'C') {
      const origPath = entries[++i];
      if (indexStatus === 'R' && origPath) {
        staged.add(origPath);
      }
    }

    if (indexStatus === '?') {
      unstaged.add(filePath);
      continue;
    }

    if (indexStatus !== ' ') {
      staged.add(filePath);
    }

    if (worktreeStatus !== ' ') {
      unstaged.add(filePath);
    }
  }

  return {
    staged: Array.from(staged),
    unstaged: Array.from(unstaged),
  };
}

export async function getStatus(repoRoot: string): Promise<GitStatus> {
  const result = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], repoRoot);
  return parseStatus(result.stdout);
}

export async function stageAll(repoRoot: string): Promise<void> {
  await runGit(['add', '-A'], repoRoot);
}

export async function getStagedDiff(repoRoot: string): Promise<string> {
  // -U8 shows 8 lines of context (default is 3)
  const result = await runGit(['diff', '-U8', '--cached'], repoRoot);
  return result.stdout;
}

export async function stageFiles(repoRoot: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  await runGit(['add', '--', ...files], repoRoot);
}

export async function unstageAll(repoRoot: string): Promise<void> {
  await runGit(['reset', '-q', 'HEAD'], repoRoot);
}

export async function hasHead(repoRoot: string): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--verify', '-q', 'HEAD'], repoRoot);
    return true;
  } catch {
    return false;
  }
}

export interface WorkingTreeDiff {
  files: string[];
  diff: string;
}

/**
 * Diff of every change in the working tree against HEAD, including untracked files,
 * without touching the real index. Renames are shown as delete + add so that every
 * path in the diff can be staged on its own.
 */
export async function getWorkingTreeDiff(
  repoRoot: string,
  contextLines: number,
): Promise<WorkingTreeDiff> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aicmt-index-'));
  const env = { GIT_INDEX_FILE: path.join(tempDir, 'index') };

  try {
    await runGit(['read-tree', 'HEAD'], repoRoot, env);
    await runGit(['add', '-A'], repoRoot, env);

    const names = await runGit(
      ['diff', '--cached', '--no-renames', '--name-only', '-z', 'HEAD'],
      repoRoot,
      env,
    );
    const diff = await runGit(
      ['diff', '--cached', '--no-renames', `-U${contextLines}`, 'HEAD'],
      repoRoot,
      env,
    );

    return {
      files: names.stdout.split('\0').filter(Boolean),
      diff: diff.stdout,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Keeps only the diff blocks of the given files. */
export function filterDiffByFiles(diff: string, files: string[]): string {
  const wanted = new Set(files);
  const kept: string[] = [];
  let keep = false;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      keep = wanted.has(extractFileFromDiffHeader(line));
    }
    if (keep) {
      kept.push(line);
    }
  }

  return kept.join('\n');
}

function stripDiffPathPrefix(raw: string): string | null {
  const value = raw.replace(/\t$/, '');
  if (value === '/dev/null') {
    return null;
  }
  return value.replace(/^[ab]\//, '');
}

export function extractFileFromDiffHeader(line: string): string {
  // "diff --git a/path/to/file b/path/to/file" -> "path/to/file"
  // Both sides are equal with --no-renames, so split the rest in half.
  const rest = line.slice('diff --git '.length);
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === ' ') {
    const left = rest.slice(0, half);
    const right = rest.slice(half + 1);
    if (left.slice(2) === right.slice(2)) {
      return right.slice(2);
    }
  }
  const match = rest.match(/^a\/(.+) b\/(.+)$/);
  return match ? match[2] : '';
}

function extractHunkSummary(lines: string[], maxLines = 5): string {
  const changes = lines
    .filter((line) => line.startsWith('+') || line.startsWith('-'))
    .filter((line) => !line.startsWith('+++') && !line.startsWith('---'))
    .slice(0, maxLines)
    .map((line) => line.slice(0, 100)); // truncate long lines
  return changes.join('\n');
}

export function parseDiffHunks(diff: string): DiffHunk[] {
  const lines = diff.split('\n');
  const hunks: DiffHunk[] = [];

  let currentFile = '';
  let currentFileHeader: string[] = [];
  let currentHunkIndex = 0;
  let currentHunkLines: string[] = [];
  let inHunk = false;

  const flushHunk = () => {
    if (currentHunkLines.length > 0 && currentFile) {
      hunks.push({
        id: `${currentFile}:${currentHunkIndex}`,
        file: currentFile,
        hunkIndex: currentHunkIndex,
        wholeFile: false,
        content: [...currentHunkLines],
        fileHeader: [...currentFileHeader],
        summary: extractHunkSummary(currentHunkLines),
      });
    }
    currentHunkLines = [];
  };

  // Files without text hunks (binary, mode change, empty file) become one whole-file unit
  const flushFile = () => {
    flushHunk();
    if (currentFile && currentHunkIndex === 0) {
      hunks.push({
        id: `${currentFile}:0`,
        file: currentFile,
        hunkIndex: 0,
        wholeFile: true,
        content: [],
        fileHeader: [...currentFileHeader],
        summary: currentFileHeader.slice(1).join('\n'),
      });
    }
  };

  for (const line of lines) {
    // New file
    if (line.startsWith('diff --git ')) {
      flushFile();
      currentFile = extractFileFromDiffHeader(line);
      currentFileHeader = [line];
      currentHunkIndex = 0;
      inHunk = false;
      continue;
    }

    // File header lines (index, ---, +++, modes, binary markers)
    if (!inHunk && !line.startsWith('@@')) {
      if (line.startsWith('--- ') || line.startsWith('+++ ')) {
        const filePath = stripDiffPathPrefix(line.slice(4));
        if (filePath) {
          currentFile = filePath;
        }
      }
      if (currentFile) {
        currentFileHeader.push(line);
      }
      continue;
    }

    // Hunk header
    if (line.startsWith('@@')) {
      flushHunk();
      currentHunkLines = [line];
      currentHunkIndex++;
      inHunk = true;
      continue;
    }

    // Hunk content
    if (inHunk) {
      currentHunkLines.push(line);
    }
  }

  flushFile();
  return hunks;
}

export function buildPatchFromHunks(hunks: DiffHunk[]): string {
  if (hunks.length === 0) return '';

  // Group hunks by file
  const byFile = new Map<string, DiffHunk[]>();
  for (const hunk of hunks) {
    const existing = byFile.get(hunk.file) || [];
    existing.push(hunk);
    byFile.set(hunk.file, existing);
  }

  const patchParts: string[] = [];

  for (const fileHunks of byFile.values()) {
    // Sort hunks by index to maintain order
    fileHunks.sort((a, b) => a.hunkIndex - b.hunkIndex);

    // Use file header from first hunk
    const fileHeader = fileHunks[0].fileHeader;
    patchParts.push(fileHeader.join('\n'));

    // Add all hunks
    for (const hunk of fileHunks) {
      patchParts.push(hunk.content.join('\n'));
    }
  }

  return patchParts.join('\n') + '\n';
}

export async function applyPatch(repoRoot: string, patch: string): Promise<void> {
  if (!patch.trim()) return;

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aicmt-patch-'));
  const tempPath = path.join(tempDir, 'patch.diff');
  await fs.writeFile(tempPath, patch, 'utf8');

  try {
    // Apply patch to index (staging area) only
    await runGit(['apply', '--cached', tempPath], repoRoot);
  } finally {
    try {
      await fs.unlink(tempPath);
      await fs.rmdir(tempDir);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/** Current branch name, or undefined on a detached HEAD. */
export async function getCurrentBranch(repoRoot: string): Promise<string | undefined> {
  try {
    const result = await runGit(['symbolic-ref', '--short', '-q', 'HEAD'], repoRoot);
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The editor git itself would use (GIT_EDITOR, core.editor, VISUAL, EDITOR, then vi). */
export async function getGitEditor(repoRoot: string): Promise<string> {
  const result = await runGit(['var', 'GIT_EDITOR'], repoRoot);
  return result.stdout.trim();
}

export async function getCurrentHead(repoRoot: string): Promise<string> {
  const result = await runGit(['rev-parse', 'HEAD'], repoRoot);
  return result.stdout.trim();
}

export async function resetToCommit(repoRoot: string, commitHash: string): Promise<void> {
  await runGit(['reset', '--mixed', commitHash], repoRoot);
}

export async function commitWithMessage(repoRoot: string, message: string): Promise<void> {
  if (!message.includes('\n')) {
    await runGit(['commit', '-m', message], repoRoot);
    return;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aicmt-'));
  const tempPath = path.join(tempDir, 'commit-message.txt');
  await fs.writeFile(tempPath, message, 'utf8');
  try {
    await runGit(['commit', '-F', tempPath], repoRoot);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
