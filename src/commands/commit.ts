import prompts from 'prompts';
import { loadConfig, resolveConfigPath } from '../config';
import {
  commitWithMessage,
  getRepoRoot,
  getStagedDiff,
  getStagedFiles,
  getStatus,
  isGitRepo,
  stageAll,
} from '../git';
import { generateCommitMessages, OpenRouterDebugInfo } from '../openrouter';

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
}

export async function runCommit({
  cwd,
  configPath,
  dryRun = false,
  verbose = false,
}: CommitOptions): Promise<void> {
  const isRepo = await isGitRepo(cwd);
  if (!isRepo) {
    throw new Error('Not a git repository. Run inside a git project.');
  }

  const repoRoot = await getRepoRoot(cwd);
  const resolvedConfigPath = resolveConfigPath(repoRoot, configPath);
  const config = await loadConfig(resolvedConfigPath);

  let status = await getStatus(repoRoot);
  if (status.staged.length === 0 && status.unstaged.length === 0) {
    throw new Error('No changes to commit.');
  }

  if (status.unstaged.length > 0) {
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
    status = await getStatus(repoRoot);
  }

  if (status.staged.length === 0) {
    throw new Error('No staged changes to commit.');
  }

  const stagedFiles = await getStagedFiles(repoRoot);
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
    stagedFiles,
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
      console.log('[ai-committer] AI request payload:');
      console.log(JSON.stringify(debugInfo.request.payload, null, 2));
      console.log('[ai-committer] AI request prompt:');
      console.log(debugInfo.request.prompt);
    }

    if (debugInfo.response) {
      const status = debugInfo.response.status ?? 'unknown';
      console.log(`[ai-committer] AI response (status ${status}):`);
      console.log(debugInfo.response.responseText ?? '');
    }
  }

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

  let finalMessage = String(choicePrompt.selection);

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

  if (!finalMessage) {
    throw new Error('Commit message is empty.');
  }

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

  if (dryRun) {
    console.log(`[dry-run] ${finalMessage}`);
    return;
  }

  await commitWithMessage(repoRoot, finalMessage);
  console.log('Commit created.');
}
