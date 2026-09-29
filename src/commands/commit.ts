import prompts from 'prompts';
import { BranchPrefix, ConfigLayer, loadConfig, ResolvedConfig } from '../config';
import {
  applyPatch,
  buildPatchFromHunks,
  commitWithMessage,
  DiffHunk,
  filterDiffByFiles,
  getCurrentBranch,
  getCurrentHead,
  getGitEditor,
  getRepoRoot,
  getStagedDiff,
  getStatus,
  getWorkingTreeDiff,
  hasHead,
  isGitRepo,
  parseDiffHunks,
  resetToCommit,
  stageAll,
  stageFiles,
  unstageAll,
} from '../git';
import {
  AiDebugInfo,
  CommitGroup,
  generateCommitGroups,
  generateCommitGroupsFromHunks,
  generateCommitMessages,
  HunkCommitGroup,
  reconcileFileGroups,
  reconcileHunkGroups,
} from '../ai';
import { createPathMatcher, editInEditor, withSpinner } from '../utils';

const promptOptions = {
  onCancel: () => {
    throw new Error('Cancelled');
  },
};

export interface CommitOptions {
  cwd: string;
  configPath?: string;
  dryRun?: boolean;
  verbose?: boolean;
  yes?: boolean;
  all?: boolean;
  split?: boolean;
  splitHunks?: boolean;
  /** Skip every prefix, including one derived from the branch. */
  noPrefix?: boolean;
  /** Settings given on the command line; they win over every config file. */
  overrides?: ConfigLayer;
}

interface SplitCommitOptions {
  repoRoot: string;
  config: ResolvedConfig;
  dryRun: boolean;
  verbose: boolean;
  yes: boolean;
  prefix?: string;
}

interface DebugCollector {
  onDebug: (info: AiDebugInfo) => void;
  print: () => void;
}

function createDebugCollector(verbose: boolean): DebugCollector {
  const debugInfo: {
    request?: AiDebugInfo;
    response?: AiDebugInfo;
  } = {};

  return {
    onDebug: (info) => {
      if (info.stage === 'request') {
        debugInfo.request = info;
      } else {
        debugInfo.response = info;
      }
    },
    print: () => {
      if (!verbose) {
        return;
      }

      if (debugInfo.request) {
        console.log('[aicmt] AI request payload:');
        console.log(JSON.stringify(debugInfo.request.payload, null, 2));
        console.log('[aicmt] AI request prompt:');
        console.log(debugInfo.request.prompt);
      }

      if (debugInfo.response) {
        const responseStatus = debugInfo.response.status ?? 'unknown';
        console.log(`[aicmt] AI response (status ${responseStatus}):`);
        console.log(debugInfo.response.responseText ?? '');
      }
    },
  };
}

function formatCommitGroups(groups: CommitGroup[]): string {
  return groups
    .map((group, index) => {
      const files = group.files.map((f) => `    - ${f}`).join('\n');
      return `  ${index + 1}. ${group.message}\n${files}`;
    })
    .join('\n\n');
}

function formatHunkGroups(groups: HunkCommitGroup[]): string {
  return groups
    .map((group, index) => {
      const hunkDetails = group.hunkIds.map((id) => `    - ${id}`).join('\n');
      return `  ${index + 1}. ${group.message}\n${hunkDetails}`;
    })
    .join('\n\n');
}

function applyPrefix(message: string, prefix?: string): string {
  if (!prefix || message.startsWith(prefix)) {
    return message;
  }
  return `${prefix}${message}`;
}

/**
 * Builds a prefix from the branch name, e.g. pattern "[A-Z]+-\d+" turns
 * "feature/DEV-95-login" into "DEV-95: ". The template can use {match} (first capture
 * group, or the whole match) and numbered groups like {1}.
 */
export function prefixFromBranch(branch: string, { pattern, template }: BranchPrefix): string | undefined {
  const match = branch.match(new RegExp(pattern));
  if (!match) {
    return undefined;
  }

  return (template ?? '{match}: ').replace(/\{(match|\d+)\}/g, (_, key: string) =>
    key === 'match' ? (match[1] ?? match[0]) : (match[Number(key)] ?? ''),
  );
}

async function resolvePrefix(repoRoot: string, config: ResolvedConfig): Promise<string | undefined> {
  if (config.prefix) {
    return config.prefix;
  }

  if (!config.branchPrefix) {
    return undefined;
  }

  const branch = await getCurrentBranch(repoRoot);
  return branch ? prefixFromBranch(branch, config.branchPrefix) : undefined;
}

async function ensureHead(repoRoot: string): Promise<void> {
  if (!(await hasHead(repoRoot))) {
    throw new Error('Split mode needs at least one existing commit. Create the initial commit first.');
  }
}

/** Commit message for changes the model left out of its grouping. */
async function generateLeftoverMessage(
  config: ResolvedConfig,
  diff: string,
  verbose: boolean,
): Promise<string> {
  const debug = createDebugCollector(verbose);
  const messages = await withSpinner('Generating message for the remaining changes...', () =>
    generateCommitMessages({ settings: config, diff, count: 1, onDebug: debug.onDebug }),
  );
  debug.print();
  return messages[0];
}

async function confirmSplit(count: number, yes: boolean): Promise<boolean> {
  if (yes) {
    return true;
  }

  const { confirm } = await prompts(
    {
      type: 'confirm',
      name: 'confirm',
      message: `\nProceed with these ${count} commits?`,
      initial: true,
    },
    promptOptions,
  );

  return Boolean(confirm);
}

/**
 * Runs the commit steps; if any of them fails, resets back to the original HEAD
 * (mixed reset: the working tree is untouched) and rethrows.
 */
async function commitGroupsWithRollback<T extends { message: string }>(
  repoRoot: string,
  groups: T[],
  prefix: string | undefined,
  stageGroup: (group: T) => Promise<void>,
): Promise<void> {
  const originalHead = await getCurrentHead(repoRoot);
  let createdCount = 0;

  // Start from a clean index: every group is staged from scratch
  await unstageAll(repoRoot);

  try {
    for (const group of groups) {
      await stageGroup(group);
      const prefixedMessage = applyPrefix(group.message, prefix);
      await commitWithMessage(repoRoot, prefixedMessage);
      createdCount++;
      console.log(`Commit ${createdCount}/${groups.length}: ${prefixedMessage}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`\nError during split: ${message}`);

    try {
      await resetToCommit(repoRoot, originalHead);
      if (createdCount > 0) {
        console.error(`Rolled back ${createdCount} commits. Your changes are left in the working tree.`);
      }
    } catch (rollbackError) {
      const rollbackMsg = rollbackError instanceof Error ? rollbackError.message : 'Unknown';
      console.error(`Rollback failed: ${rollbackMsg}`);
      console.error(`Manual recovery: git reset --mixed ${originalHead}`);
    }

    throw error;
  }

  console.log(`\nSuccessfully created ${createdCount} commits.`);

  const remaining = await getStatus(repoRoot);
  const remainingFiles = [...new Set([...remaining.staged, ...remaining.unstaged])];
  if (remainingFiles.length > 0) {
    console.warn(`Warning: ${remainingFiles.length} changed files were not committed:`);
    remainingFiles.forEach((file) => console.warn(`  - ${file}`));
  }
}

async function runSplitCommit({
  repoRoot,
  config,
  dryRun,
  verbose,
  yes,
  prefix,
}: SplitCommitOptions): Promise<void> {
  await ensureHead(repoRoot);

  // Diff and file list come from the same snapshot (untracked files included),
  // so the model sees the content of every file it is asked to group
  const { files, diff } = await getWorkingTreeDiff(repoRoot, 8);

  if (files.length === 0) {
    throw new Error('No changes to commit.');
  }

  const debug = createDebugCollector(verbose);

  // Ask AI to group the files into logical commits
  const rawGroups = await withSpinner(`Analyzing ${files.length} changed files...`, () =>
    generateCommitGroups({ settings: config, diff, files, onDebug: debug.onDebug }),
  );
  debug.print();

  const { groups, leftover } = reconcileFileGroups(rawGroups, files);

  if (leftover.length > 0) {
    console.log(`AI skipped ${leftover.length} files, generating a separate commit for them.`);
    const message = await generateLeftoverMessage(
      config,
      filterDiffByFiles(diff, leftover),
      verbose,
    );
    groups.push({ files: leftover, message });
  }

  console.log(`\nProposed ${groups.length} commits:\n`);
  console.log(formatCommitGroups(groups));

  if (!(await confirmSplit(groups.length, yes))) {
    console.log('Split commit cancelled.');
    return;
  }

  if (dryRun) {
    console.log('\n[dry-run] Would create the following commits:');
    for (const group of groups) {
      const prefixedMessage = applyPrefix(group.message, prefix);
      console.log(`  - ${prefixedMessage} (${group.files.length} files)`);
    }
    return;
  }

  await commitGroupsWithRollback(repoRoot, groups, prefix, (group) =>
    stageFiles(repoRoot, group.files),
  );
}

async function runSplitHunksCommit({
  repoRoot,
  config,
  dryRun,
  verbose,
  yes,
  prefix,
}: SplitCommitOptions): Promise<void> {
  await ensureHead(repoRoot);

  // Minimal context for granular hunks, full context for AI understanding
  const hunkDiff = await getWorkingTreeDiff(repoRoot, 1);
  const hunks = parseDiffHunks(hunkDiff.diff);
  const { diff: fullDiff } = await getWorkingTreeDiff(repoRoot, 8);

  if (hunks.length === 0) {
    throw new Error('No changes to commit.');
  }

  const hunksMap = new Map<string, DiffHunk>();
  for (const hunk of hunks) {
    hunksMap.set(hunk.id, hunk);
  }

  console.log('(experimental hunk-level split mode)');

  const isIgnored = createPathMatcher(config.ignore);
  const debug = createDebugCollector(verbose);

  // Ask AI to group hunks into logical commits
  const rawGroups = await withSpinner(
    `Analyzing ${hunks.length} hunks across ${hunkDiff.files.length} files...`,
    () =>
      generateCommitGroupsFromHunks({
        settings: config,
        hunks: hunks.map((h) => ({
          id: h.id,
          file: h.file,
          summary: isIgnored(h.file) ? '[content omitted]' : h.summary,
        })),
        fullDiff,
        onDebug: debug.onDebug,
      }),
  );
  debug.print();

  const { groups, leftover } = reconcileHunkGroups(rawGroups, [...hunksMap.keys()]);

  if (leftover.length > 0) {
    console.log(`AI skipped ${leftover.length} hunks, generating a separate commit for them.`);
    const leftoverHunks = leftover.map((id) => hunksMap.get(id) as DiffHunk);
    const message = await generateLeftoverMessage(
      config,
      buildPatchFromHunks(leftoverHunks.filter((h) => !h.wholeFile)) +
        filterDiffByFiles(fullDiff, leftoverHunks.filter((h) => h.wholeFile).map((h) => h.file)),
      verbose,
    );
    groups.push({ hunkIds: leftover, message });
  }

  console.log(`\nProposed ${groups.length} commits:\n`);
  console.log(formatHunkGroups(groups));

  if (!(await confirmSplit(groups.length, yes))) {
    console.log('Split commit cancelled.');
    return;
  }

  if (dryRun) {
    console.log('\n[dry-run] Would create the following commits:');
    for (const group of groups) {
      const prefixedMessage = applyPrefix(group.message, prefix);
      console.log(`  - ${prefixedMessage} (${group.hunkIds.length} hunks)`);
    }
    return;
  }

  await commitGroupsWithRollback(repoRoot, groups, prefix, async (group) => {
    const groupHunks = group.hunkIds.map((id) => hunksMap.get(id) as DiffHunk);
    // Binary, mode-only and empty-file changes have no text hunks: stage the whole file
    await stageFiles(
      repoRoot,
      groupHunks.filter((h) => h.wholeFile).map((h) => h.file),
    );
    await applyPatch(repoRoot, buildPatchFromHunks(groupHunks.filter((h) => !h.wholeFile)));
  });
}

/**
 * Decides what goes into a regular commit: the index as it is, unless --all is given or
 * nothing is staged yet (then everything is staged, after asking unless --yes).
 */
async function prepareStaging(repoRoot: string, all: boolean, yes: boolean): Promise<void> {
  const status = await getStatus(repoRoot);

  if (all) {
    await stageAll(repoRoot);
    return;
  }

  if (status.staged.length === 0) {
    if (!yes) {
      const { stage } = await prompts(
        {
          type: 'confirm',
          name: 'stage',
          message: 'Nothing is staged. Stage all changes?',
          initial: true,
        },
        promptOptions,
      );

      if (!stage) {
        throw new Error('Nothing to commit: stage changes with git add or use --all.');
      }
    }

    await stageAll(repoRoot);
    return;
  }

  if (status.unstaged.length > 0) {
    console.log(
      `Committing staged changes only; ${status.unstaged.length} files with unstaged changes are not included (use --all to include them).`,
    );
  }
}

async function editMessage(repoRoot: string, message: string): Promise<string> {
  // A one-line message is quicker to fix inline; multi-line ones go to the editor
  if (!message.includes('\n')) {
    const { edited } = await prompts(
      {
        type: 'text',
        name: 'edited',
        message: 'Edit commit message',
        initial: message,
      },
      promptOptions,
    );
    return String(edited ?? '').trim() || message;
  }

  const editor = await getGitEditor(repoRoot);
  return (await editInEditor(editor, message, repoRoot)) || message;
}

/** Interactive choice: pick, regenerate, write or edit a message. Returns null if aborted. */
async function chooseMessage(
  repoRoot: string,
  generate: () => Promise<string[]>,
  prefix: string | undefined,
): Promise<string | null> {
  let messages = await generate();

  for (;;) {
    const { selection } = await prompts(
      {
        type: 'select',
        name: 'selection',
        message: 'Choose a commit message',
        choices: [
          ...messages.map((message, index) => ({
            title: message,
            value: message,
            description: `Option ${index + 1}`,
          })),
          { title: 'Regenerate', value: '__regenerate', description: 'Ask the AI for new options' },
          { title: 'Custom message', value: '__custom', description: 'Write your own' },
          { title: 'Abort', value: '__abort', description: 'Cancel commit' },
        ],
      },
      promptOptions,
    );

    if (!selection || selection === '__abort') {
      return null;
    }

    if (selection === '__regenerate') {
      messages = await generate();
      continue;
    }

    let message = String(selection);
    if (selection === '__custom') {
      const { customMessage } = await prompts(
        {
          type: 'text',
          name: 'customMessage',
          message: 'Enter commit message',
          validate: (value: string) =>
            value.trim().length > 0 ? true : 'Commit message is required.',
        },
        promptOptions,
      );
      message = String(customMessage || '').trim();
    }

    for (;;) {
      const { action } = await prompts(
        {
          type: 'select',
          name: 'action',
          message: `Commit with message:\n${applyPrefix(message, prefix)}\n`,
          choices: [
            { title: 'Commit', value: 'commit' },
            { title: 'Edit message', value: 'edit' },
            { title: 'Back to options', value: 'back' },
            { title: 'Cancel', value: 'cancel' },
          ],
        },
        promptOptions,
      );

      if (action === 'commit') {
        return message;
      }
      if (action === 'edit') {
        message = await editMessage(repoRoot, message);
        continue;
      }
      if (action === 'back') {
        break;
      }
      return null;
    }
  }
}

export async function runCommit({
  cwd,
  configPath,
  dryRun = false,
  verbose = false,
  yes = false,
  all = false,
  split = false,
  splitHunks = false,
  noPrefix = false,
  overrides,
}: CommitOptions): Promise<void> {
  const isRepo = await isGitRepo(cwd);
  if (!isRepo) {
    throw new Error('Not a git repository. Run inside a git project.');
  }

  const repoRoot = await getRepoRoot(cwd);
  const { config } = await loadConfig(repoRoot, { configPath, cli: overrides });
  const prefix = noPrefix ? undefined : await resolvePrefix(repoRoot, config);

  const status = await getStatus(repoRoot);
  if (status.staged.length === 0 && status.unstaged.length === 0) {
    throw new Error('No changes to commit.');
  }

  const splitOptions = { repoRoot, config, dryRun, verbose, yes, prefix };

  // Hunk-level split mode (experimental)
  if (splitHunks) {
    await runSplitHunksCommit(splitOptions);
    return;
  }

  // File-level split mode
  if (split) {
    await runSplitCommit(splitOptions);
    return;
  }

  await prepareStaging(repoRoot, all, yes);

  const diff = await getStagedDiff(repoRoot);
  if (!diff.trim()) {
    throw new Error('No staged changes to commit.');
  }

  const generate = async () => {
    const debug = createDebugCollector(verbose);
    const messages = await withSpinner('Generating commit messages...', () =>
      generateCommitMessages({
        settings: config,
        diff,
        count: yes ? 1 : config.count,
        onDebug: debug.onDebug,
      }),
    );
    debug.print();
    return messages;
  };

  const finalMessage = yes
    ? (await generate())[0]
    : await chooseMessage(repoRoot, generate, prefix);

  if (finalMessage === null) {
    console.log('Commit cancelled.');
    return;
  }

  if (!finalMessage.trim()) {
    throw new Error('Commit message is empty.');
  }

  const prefixedMessage = applyPrefix(finalMessage, prefix);

  if (dryRun) {
    console.log(`[dry-run] ${prefixedMessage}`);
    return;
  }

  await commitWithMessage(repoRoot, prefixedMessage);
  console.log(`Commit created: ${prefixedMessage}`);
}
