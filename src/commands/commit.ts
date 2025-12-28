import prompts from 'prompts';
import { loadGlobalConfig, resolveConfigPath, resolveProjectConfig } from '../config';
import {
  applyPatch,
  buildPatchFromHunks,
  commitWithMessage,
  DiffHunk,
  getCurrentHead,
  getFullDiff,
  getRepoRoot,
  getStagedDiff,
  getStatus,
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
}

interface SplitCommitOptions {
  repoRoot: string;
  config: {
    openrouterApiKey: string;
    model: string;
    instructions: string;
    temperature: number;
    maxTokens: number;
  };
  status: { staged: string[]; unstaged: string[] };
  dryRun: boolean;
  verbose: boolean;
  yes: boolean;
}

function formatCommitGroups(groups: CommitGroup[]): string {
  return groups
    .map((group, index) => {
      const files = group.files.map((f) => `    - ${f}`).join('\n');
      return `  ${index + 1}. ${group.message}\n${files}`;
    })
    .join('\n\n');
}

async function runSplitCommit({
  repoRoot,
  config,
  status,
  dryRun,
  verbose,
  yes,
}: SplitCommitOptions): Promise<void> {
  // Collect all changed files
  const allFiles = [...new Set([...status.staged, ...status.unstaged])];

  if (allFiles.length === 0) {
    throw new Error('No changes to commit.');
  }

  // Ensure we have a clean staging area to work with
  if (status.staged.length > 0) {
    await unstageAll(repoRoot);
  }

  // Get the full diff of all changes
  const diff = await getFullDiff(repoRoot);

  console.log(`Analyzing ${allFiles.length} changed files...`);

  const debugInfo: {
    request?: OpenRouterDebugInfo;
    response?: OpenRouterDebugInfo;
  } = {};

  // Ask AI to group the files into logical commits
  const groups = await generateCommitGroups({
    apiKey: config.openrouterApiKey,
    model: config.model,
    instructions: config.instructions,
    diff,
    files: allFiles,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    onDebug: (info) => {
      if (info.stage === 'request') {
        debugInfo.request = info;
      } else {
        debugInfo.response = info;
      }
    },
  });

  if (verbose) {
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
  }

  console.log(`\nProposed ${groups.length} commits:\n`);
  console.log(formatCommitGroups(groups));

  if (!yes) {
    const { confirm } = await prompts(
      {
        type: 'confirm',
        name: 'confirm',
        message: `\nProceed with these ${groups.length} commits?`,
        initial: true,
      },
      promptOptions,
    );

    if (!confirm) {
      console.log('Split commit cancelled.');
      return;
    }
  }

  if (dryRun) {
    console.log('\n[dry-run] Would create the following commits:');
    for (const group of groups) {
      console.log(`  - ${group.message} (${group.files.length} files)`);
    }
    return;
  }

  // Create commits one by one
  let createdCount = 0;
  for (const group of groups) {
    try {
      // Stage only the files for this commit
      await stageFiles(repoRoot, group.files);

      // Create the commit
      await commitWithMessage(repoRoot, group.message);
      createdCount++;
      console.log(`Commit ${createdCount}/${groups.length}: ${group.message}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Failed to create commit: ${message}`);
      console.error(`Files: ${group.files.join(', ')}`);
      throw error;
    }
  }

  console.log(`\nSuccessfully created ${createdCount} commits.`);
}

function formatHunkGroups(groups: HunkCommitGroup[], hunksMap: Map<string, DiffHunk>): string {
  return groups
    .map((group, index) => {
      const hunkDetails = group.hunkIds.map((id) => {
        const hunk = hunksMap.get(id);
        return hunk ? `    - ${id}` : `    - ${id} (unknown)`;
      }).join('\n');
      return `  ${index + 1}. ${group.message}\n${hunkDetails}`;
    })
    .join('\n\n');
}

async function runSplitHunksCommit({
  repoRoot,
  config,
  status,
  dryRun,
  verbose,
  yes,
}: SplitCommitOptions): Promise<void> {
  // Collect all changed files
  const allFiles = [...new Set([...status.staged, ...status.unstaged])];

  if (allFiles.length === 0) {
    throw new Error('No changes to commit.');
  }

  // Ensure we have a clean staging area
  if (status.staged.length > 0) {
    await unstageAll(repoRoot);
  }

  // Get the full diff and parse into hunks
  const diff = await getFullDiff(repoRoot);
  const hunks = parseDiffHunks(diff);

  if (hunks.length === 0) {
    throw new Error('No hunks found in diff.');
  }

  // Create a map for quick lookup
  const hunksMap = new Map<string, DiffHunk>();
  for (const hunk of hunks) {
    hunksMap.set(hunk.id, hunk);
  }

  console.log(`Analyzing ${hunks.length} hunks across ${allFiles.length} files...`);
  console.log('(experimental hunk-level split mode)\n');

  const debugInfo: {
    request?: OpenRouterDebugInfo;
    response?: OpenRouterDebugInfo;
  } = {};

  // Ask AI to group hunks into logical commits
  const groups = await generateCommitGroupsFromHunks({
    apiKey: config.openrouterApiKey,
    model: config.model,
    instructions: config.instructions,
    hunks: hunks.map((h) => ({ id: h.id, file: h.file, summary: h.summary })),
    fullDiff: diff,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    onDebug: (info) => {
      if (info.stage === 'request') {
        debugInfo.request = info;
      } else {
        debugInfo.response = info;
      }
    },
  });

  if (verbose) {
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
  }

  console.log(`Proposed ${groups.length} commits:\n`);
  console.log(formatHunkGroups(groups, hunksMap));

  if (!yes) {
    const { confirm } = await prompts(
      {
        type: 'confirm',
        name: 'confirm',
        message: `\nProceed with these ${groups.length} commits?`,
        initial: true,
      },
      promptOptions,
    );

    if (!confirm) {
      console.log('Split commit cancelled.');
      return;
    }
  }

  if (dryRun) {
    console.log('\n[dry-run] Would create the following commits:');
    for (const group of groups) {
      console.log(`  - ${group.message} (${group.hunkIds.length} hunks)`);
    }
    return;
  }

  // Save current HEAD for potential rollback
  const originalHead = await getCurrentHead(repoRoot);
  let createdCount = 0;

  try {
    for (const group of groups) {
      // Get hunks for this group
      const groupHunks = group.hunkIds
        .map((id) => hunksMap.get(id))
        .filter((h): h is DiffHunk => h !== undefined);

      if (groupHunks.length === 0) {
        console.warn(`Warning: No valid hunks for commit "${group.message}", skipping.`);
        continue;
      }

      // Build and apply patch
      const patch = buildPatchFromHunks(groupHunks);
      await applyPatch(repoRoot, patch);

      // Create commit
      await commitWithMessage(repoRoot, group.message);
      createdCount++;
      console.log(`Commit ${createdCount}/${groups.length}: ${group.message}`);
    }

    console.log(`\nSuccessfully created ${createdCount} commits.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`\nError during hunk split: ${message}`);

    if (createdCount > 0) {
      console.error(`Rolling back ${createdCount} commits...`);
      try {
        await resetToCommit(repoRoot, originalHead);
        console.log('Rollback successful. Repository restored to original state.');
      } catch (rollbackError) {
        const rollbackMsg = rollbackError instanceof Error ? rollbackError.message : 'Unknown';
        console.error(`Rollback failed: ${rollbackMsg}`);
        console.error(`Manual recovery: git reset --mixed ${originalHead}`);
      }
    }

    throw error;
  }
}

export async function runCommit({
  cwd,
  configPath,
  dryRun = false,
  verbose = false,
  yes = false,
  split = false,
  splitHunks = false,
}: CommitOptions): Promise<void> {
  const isRepo = await isGitRepo(cwd);
  if (!isRepo) {
    throw new Error('Not a git repository. Run inside a git project.');
  }

  const repoRoot = await getRepoRoot(cwd);
  const resolvedConfigPath = resolveConfigPath(repoRoot, configPath);
  const globalConfig = await loadGlobalConfig(resolvedConfigPath);
  const config = resolveProjectConfig(globalConfig, repoRoot);

  let status = await getStatus(repoRoot);
  if (status.staged.length === 0 && status.unstaged.length === 0) {
    throw new Error('No changes to commit.');
  }

  // Hunk-level split mode (experimental)
  if (splitHunks) {
    await runSplitHunksCommit({
      repoRoot,
      config,
      status,
      dryRun,
      verbose,
      yes,
    });
    return;
  }

  // File-level split mode
  if (split) {
    await runSplitCommit({
      repoRoot,
      config,
      status,
      dryRun,
      verbose,
      yes,
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

  const debugInfo: {
    request?: OpenRouterDebugInfo;
    response?: OpenRouterDebugInfo;
  } = {};

  const messages = await generateCommitMessages({
    apiKey: config.openrouterApiKey,
    model: config.model,
    instructions: config.instructions,
    diff,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    onDebug: (info) => {
      if (info.stage === 'request') {
        debugInfo.request = info;
      } else {
        debugInfo.response = info;
      }
    },
  });

  if (verbose) {
    if (debugInfo.request) {
      console.log('[aicmt] AI request payload:');
      console.log(JSON.stringify(debugInfo.request.payload, null, 2));
      console.log('[aicmt] AI request prompt:');
      console.log(debugInfo.request.prompt);
    }

    if (debugInfo.response) {
      const status = debugInfo.response.status ?? 'unknown';
      console.log(`[aicmt] AI response (status ${status}):`);
      console.log(debugInfo.response.responseText ?? '');
    }
  }

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

  if (!yes) {
    const { confirm } = await prompts(
      {
        type: 'confirm',
        name: 'confirm',
        message: `Commit with message:\n${finalMessage}\nProceed?`,
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
    console.log(`[dry-run] ${finalMessage}`);
    return;
  }

  await commitWithMessage(repoRoot, finalMessage);
  console.log(`Commit created: ${finalMessage}`);
}
