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
  hunkIndex: number;    // hunk index within the file
  header: string;       // @@ -a,b +c,d @@ context
  content: string[];    // lines of the hunk (including @@ line)
  fileHeader: string[]; // diff --git, index, ---, +++ lines
  summary: string;      // first few changed lines for AI context
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
  // -U8 shows 8 lines of context (default is 3)
  const result = await runGit(['diff', '-U8', '--cached'], repoRoot);
  return result.stdout;
}

export async function stageFiles(repoRoot: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  await runGit(['add', '--', ...files], repoRoot);
}

export async function unstageAll(repoRoot: string): Promise<void> {
  await runGit(['reset', 'HEAD'], repoRoot);
}

export async function getFullDiff(repoRoot: string): Promise<string> {
  // -U8 shows 8 lines of context (default is 3)
  const result = await runGit(['diff', '-U8', 'HEAD'], repoRoot);
  return result.stdout;
}

export async function getDiffForFiles(repoRoot: string, files: string[]): Promise<string> {
  if (files.length === 0) return '';
  // -U8 shows 8 lines of context (default is 3)
  const result = await runGit(['diff', '-U8', 'HEAD', '--', ...files], repoRoot);
  return result.stdout;
}

function extractFileFromDiffHeader(line: string): string {
  // "diff --git a/path/to/file b/path/to/file" -> "path/to/file"
  const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
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
  let currentHunkHeader = '';
  let inHunk = false;

  const flushHunk = () => {
    if (currentHunkLines.length > 0 && currentFile) {
      hunks.push({
        id: `${currentFile}:${currentHunkIndex}`,
        file: currentFile,
        hunkIndex: currentHunkIndex,
        header: currentHunkHeader,
        content: [...currentHunkLines],
        fileHeader: [...currentFileHeader],
        summary: extractHunkSummary(currentHunkLines),
      });
    }
    currentHunkLines = [];
    currentHunkHeader = '';
  };

  for (const line of lines) {
    // New file
    if (line.startsWith('diff --git ')) {
      flushHunk();
      currentFile = extractFileFromDiffHeader(line);
      currentFileHeader = [line];
      currentHunkIndex = 0;
      inHunk = false;
      continue;
    }

    // File header lines (index, ---, +++)
    if (!inHunk && (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ') ||
        line.startsWith('new file mode') || line.startsWith('deleted file mode') ||
        line.startsWith('old mode') || line.startsWith('new mode'))) {
      currentFileHeader.push(line);
      continue;
    }

    // Hunk header
    if (line.startsWith('@@')) {
      flushHunk();
      currentHunkHeader = line;
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

  flushHunk();
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

  for (const [file, fileHunks] of byFile) {
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
    await runGit(['apply', '--cached', '--unidiff-zero', tempPath], repoRoot);
  } finally {
    try {
      await fs.unlink(tempPath);
      await fs.rmdir(tempDir);
    } catch {
      // Ignore cleanup errors
    }
  }
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
    try {
      await fs.unlink(tempPath);
    } catch (error) {
      // Ignore cleanup errors.
    }
  }
}
