import prompts from 'prompts';
import { loadGlobalConfig, resolveConfigPath, resolveProjectConfig } from '../config';
import {
  commitWithMessage,
  getFullDiff,
  getRepoRoot,
  getStagedDiff,
  getStatus,
  isGitRepo,
  stageAll,
  stageFiles,
  unstageAll,
} from '../git';
import {
  CommitGroup,
  generateCommitGroups,
  generateCommitMessages,
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

export async function runCommit({
  cwd,
  configPath,
  dryRun = false,
  verbose = false,
  yes = false,
  split = false,
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

  // Split mode: analyze all changes and create multiple commits
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
