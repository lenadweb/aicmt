import prompts from 'prompts';
import { loadGlobalConfig, resolveConfigPath, resolveProjectConfig } from '../config';
import {
  applyPatch,
  buildPatchFromHunks,
  commitWithMessage,
  DiffHunk,
  filterDiffByFiles,
  getCurrentHead,
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
  CommitGroup,
  generateCommitGroups,
  generateCommitGroupsFromHunks,
  generateCommitMessages,
  HunkCommitGroup,
  OpenRouterDebugInfo,
  reconcileFileGroups,
  reconcileHunkGroups,
} from '../openrouter';

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
  split?: boolean;
  splitHunks?: boolean;
  prefix?: string;
  model?: string;
}

type SplitConfig = {
  openrouterApiKey: string;
  model: string;
  instructions: string;
  temperature: number;
  maxTokens: number;
};

interface SplitCommitOptions {
  repoRoot: string;
  config: SplitConfig;
  dryRun: boolean;
  verbose: boolean;
  yes: boolean;
  prefix?: string;
}

interface DebugCollector {
  onDebug: (info: OpenRouterDebugInfo) => void;
  print: () => void;
}

function createDebugCollector(verbose: boolean): DebugCollector {
  const debugInfo: {
    request?: OpenRouterDebugInfo;
    response?: OpenRouterDebugInfo;
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
  if (!prefix) {
    return message;
  }
  return `${prefix}${message}`;
}

async function ensureHead(repoRoot: string): Promise<void> {
  if (!(await hasHead(repoRoot))) {
    throw new Error('Split mode needs at least one existing commit. Create the initial commit first.');
  }
}

/** Commit message for changes the model left out of its grouping. */
async function generateLeftoverMessage(
  config: SplitConfig,
  diff: string,
  verbose: boolean,
): Promise<string> {
  const debug = createDebugCollector(verbose);
  const messages = await generateCommitMessages({
    apiKey: config.openrouterApiKey,
    model: config.model,
    instructions: config.instructions,
    diff,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    onDebug: debug.onDebug,
  });
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

  console.log(`Analyzing ${files.length} changed files...`);

  const debug = createDebugCollector(verbose);

  // Ask AI to group the files into logical commits
  const rawGroups = await generateCommitGroups({
    apiKey: config.openrouterApiKey,
    model: config.model,
    instructions: config.instructions,
    diff,
    files,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    onDebug: debug.onDebug,
  });
  debug.print();

  const { groups, leftover } = reconcileFileGroups(rawGroups, files);

  if (leftover.length > 0) {
    console.log(`AI skipped ${leftover.length} files, generating a separate commit for them...`);
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

  console.log(`Analyzing ${hunks.length} hunks across ${hunkDiff.files.length} files...`);
  console.log('(experimental hunk-level split mode)\n');

  const debug = createDebugCollector(verbose);

  // Ask AI to group hunks into logical commits
  const rawGroups = await generateCommitGroupsFromHunks({
    apiKey: config.openrouterApiKey,
    model: config.model,
    instructions: config.instructions,
    hunks: hunks.map((h) => ({ id: h.id, file: h.file, summary: h.summary })),
    fullDiff,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    onDebug: debug.onDebug,
  });
  debug.print();

  const { groups, leftover } = reconcileHunkGroups(rawGroups, [...hunksMap.keys()]);

  if (leftover.length > 0) {
    console.log(`AI skipped ${leftover.length} hunks, generating a separate commit for them...`);
    const leftoverHunks = leftover.map((id) => hunksMap.get(id) as DiffHunk);
    const message = await generateLeftoverMessage(
      config,
      buildPatchFromHunks(leftoverHunks.filter((h) => !h.wholeFile)) +
        filterDiffByFiles(fullDiff, leftoverHunks.filter((h) => h.wholeFile).map((h) => h.file)),
      verbose,
    );
    groups.push({ hunkIds: leftover, message });
  }

  console.log(`Proposed ${groups.length} commits:\n`);
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

export async function runCommit({
  cwd,
  configPath,
  dryRun = false,
  verbose = false,
  yes = false,
  split = false,
  splitHunks = false,
  prefix,
  model,
}: CommitOptions): Promise<void> {
  const isRepo = await isGitRepo(cwd);
  if (!isRepo) {
    throw new Error('Not a git repository. Run inside a git project.');
  }

  const repoRoot = await getRepoRoot(cwd);
  const resolvedConfigPath = resolveConfigPath(repoRoot, configPath);
  const globalConfig = await loadGlobalConfig(resolvedConfigPath);
  const config = resolveProjectConfig(globalConfig, repoRoot);

  const modelOverride = model?.trim();
  if (modelOverride) {
    config.model = modelOverride;
  }

  let status = await getStatus(repoRoot);
  if (status.staged.length === 0 && status.unstaged.length === 0) {
    throw new Error('No changes to commit.');
  }

  // Hunk-level split mode (experimental)
  if (splitHunks) {
    await runSplitHunksCommit({
      repoRoot,
      config,
      dryRun,
      verbose,
      yes,
      prefix,
    });
    return;
  }

  // File-level split mode
  if (split) {
    await runSplitCommit({
      repoRoot,
      config,
      dryRun,
      verbose,
      yes,
      prefix,
    });
    return;
  }

  if (status.unstaged.length > 0) {
    if (yes) {
      await stageAll(repoRoot);
    } else {
      const { stage } = await prompts(
        {
          type: 'confirm',
          name: 'stage',
          message: 'Unstaged changes detected. Stage all changes?',
          initial: true,
        },
        promptOptions,
      );

      if (!stage) {
        throw new Error('Aborted: commit requires all changes to be staged.');
      }

      await stageAll(repoRoot);
    }
    status = await getStatus(repoRoot);
  }

  if (status.staged.length === 0) {
    throw new Error('No staged changes to commit.');
  }

  const diff = await getStagedDiff(repoRoot);

  const debug = createDebugCollector(verbose);

  const messages = await generateCommitMessages({
    apiKey: config.openrouterApiKey,
    model: config.model,
    instructions: config.instructions,
    diff,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    onDebug: debug.onDebug,
  });
  debug.print();

  let finalMessage = messages[0] ?? '';

  if (!yes) {
    const choicePrompt = await prompts(
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
          { title: 'Custom message', value: '__custom', description: 'Write your own' },
          { title: 'Abort', value: '__abort', description: 'Cancel commit' },
        ],
      },
      promptOptions,
    );

    if (!choicePrompt.selection || choicePrompt.selection === '__abort') {
      console.log('Commit cancelled.');
      return;
    }

    finalMessage = String(choicePrompt.selection);

    if (choicePrompt.selection === '__custom') {
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

      finalMessage = String(customMessage || '').trim();
    }
  }

  if (!finalMessage) {
    throw new Error('Commit message is empty.');
  }

  // Apply prefix to commit message
  const prefixedMessage = applyPrefix(finalMessage, prefix);

  if (!yes) {
    const { confirm } = await prompts(
      {
        type: 'confirm',
        name: 'confirm',
        message: `Commit with message:\n${prefixedMessage}\nProceed?`,
        initial: true,
      },
      promptOptions,
    );

    if (!confirm) {
      console.log('Commit cancelled.');
      return;
    }
  }

  if (dryRun) {
    console.log(`[dry-run] ${prefixedMessage}`);
    return;
  }

  await commitWithMessage(repoRoot, prefixedMessage);
  console.log(`Commit created: ${prefixedMessage}`);
}
