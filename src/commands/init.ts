import prompts from 'prompts';
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_TEMPERATURE,
  MAX_OUTPUT_TOKENS,
  MIN_OUTPUT_TOKENS,
} from '../constants';
import {
  GlobalConfig,
  ProjectConfig,
  loadGlobalConfig,
  resolveConfigPath,
  saveGlobalConfig,
} from '../config';
import { getRepoRoot, isGitRepo } from '../git';

interface FormatChoice {
  value: string;
  title: string;
  description: string;
  instructions?: string;
}

const formatChoices: FormatChoice[] = [
  {
    value: 'conventional-scope',
    title: 'Conventional Commits (type(scope): subject)',
    description: 'Best for structured history with scopes.',
    instructions: [
      'Use Conventional Commits: type(scope): subject.',
      'Allowed types: feat, fix, docs, style, refactor, perf, test, chore, ci, build.',
      'Subject <= 72 chars, imperative mood, no trailing period.',
    ].join('\n'),
  },
  {
    value: 'conventional',
    title: 'Conventional Commits (type: subject)',
    description: 'Structured without scopes.',
    instructions: [
      'Use Conventional Commits: type: subject.',
      'Allowed types: feat, fix, docs, style, refactor, perf, test, chore, ci, build.',
      'Subject <= 72 chars, imperative mood, no trailing period.',
    ].join('\n'),
  },
  {
    value: 'short',
    title: 'Short imperative summary',
    description: 'Simple single-line format.',
    instructions: [
      'Single-line summary, imperative mood, <= 72 chars, no trailing period.',
    ].join('\n'),
  },
  {
    value: 'detailed',
    title: 'Detailed subject + body',
    description: 'Subject line plus body details.',
    instructions: [
      'Subject <= 72 chars, imperative mood, no trailing period.',
      'Blank line.',
      'Body with bullet list of key changes (wrap at 100 chars).',
    ].join('\n'),
  },
  {
    value: 'custom',
    title: 'Custom format',
    description: 'Provide your own instructions.',
  },
];

const promptOptions = {
  onCancel: () => {
    throw new Error('Cancelled');
  },
};

export interface InitOptions {
  cwd: string;
  configPath?: string;
}

function upsertProjectConfig(
  globalConfig: GlobalConfig,
  repoRoot: string,
  projectConfig: ProjectConfig,
): GlobalConfig {
  return {
    ...globalConfig,
    projects: {
      ...globalConfig.projects,
      [repoRoot]: projectConfig,
    },
  };
}

export async function runInit({ cwd, configPath }: InitOptions): Promise<void> {
  const isRepo = await isGitRepo(cwd);
  if (!isRepo) {
    throw new Error('Not a git repository. Run inside a git project.');
  }

  const repoRoot = await getRepoRoot(cwd);
  const resolvedConfigPath = resolveConfigPath(repoRoot, configPath);

  const existingConfig = await loadGlobalConfig(resolvedConfigPath, {
    allowMissing: true,
  });

  if (existingConfig.projects?.[repoRoot]) {
    const { overwrite } = await prompts(
      {
        type: 'confirm',
        name: 'overwrite',
        message: 'Config already exists for this repo. Overwrite?',
        initial: false,
      },
      promptOptions,
    );

    if (!overwrite) {
      console.log('Init cancelled.');
      return;
    }
  }

  const { format } = await prompts(
    {
      type: 'select',
      name: 'format',
      message: 'Choose commit message format',
      choices: formatChoices.map((choice) => ({
        title: choice.title,
        value: choice.value,
        description: choice.description,
      })),
      initial: 0,
    },
    promptOptions,
  );

  const selected = formatChoices.find((choice) => choice.value === format);
  if (!selected) {
    throw new Error('Invalid format selection.');
  }

  let baseInstructions = selected.instructions ?? '';
  if (selected.value === 'custom') {
    const { customInstructions } = await prompts(
      {
        type: 'text',
        name: 'customInstructions',
        message: 'Describe the commit message format',
        validate: (value: string) =>
          value.trim().length > 0 ? true : 'Please enter instructions.',
      },
      promptOptions,
    );
    baseInstructions = String(customInstructions || '').trim();
  }

  const { extraInstructions } = await prompts(
    {
      type: 'text',
      name: 'extraInstructions',
      message: 'Additional instructions (optional)',
      initial: '',
    },
    promptOptions,
  );

  const extra = String(extraInstructions || '').trim();
  const instructions = extra ? `${baseInstructions}\n${extra}` : baseInstructions;

  const { model } = await prompts(
    {
      type: 'text',
      name: 'model',
      message: 'OpenRouter model',
      initial: DEFAULT_MODEL,
      validate: (value: string) =>
        value.trim().length > 0 ? true : 'Model is required.',
    },
    promptOptions,
  );

  const { temperature } = await prompts(
    {
      type: 'number',
      name: 'temperature',
      message: 'Temperature (0-2)',
      initial: DEFAULT_TEMPERATURE,
      min: 0,
      max: 2,
      float: true,
    },
    promptOptions,
  );

  const { maxTokens } = await prompts(
    {
      type: 'number',
      name: 'maxTokens',
      message: `Max tokens (${MIN_OUTPUT_TOKENS}-${MAX_OUTPUT_TOKENS})`,
      initial: DEFAULT_MAX_TOKENS,
      min: MIN_OUTPUT_TOKENS,
      max: MAX_OUTPUT_TOKENS,
    },
    promptOptions,
  );

  let globalApiKey = existingConfig.openrouterApiKey ?? '';
  if (globalApiKey) {
    const { reuseKey } = await prompts(
      {
        type: 'confirm',
        name: 'reuseKey',
        message: 'Use existing global OpenRouter API key?',
        initial: true,
      },
      promptOptions,
    );

    if (!reuseKey) {
      const { apiKey } = await prompts(
        {
          type: 'password',
          name: 'apiKey',
          message: 'OpenRouter API key',
          validate: (value: string) =>
            value.trim().length > 0 ? true : 'API key is required.',
        },
        promptOptions,
      );
      globalApiKey = String(apiKey || '').trim();
    }
  } else {
    const { apiKey } = await prompts(
      {
        type: 'password',
        name: 'apiKey',
        message: 'OpenRouter API key',
        validate: (value: string) =>
          value.trim().length > 0 ? true : 'API key is required.',
      },
      promptOptions,
    );
    globalApiKey = String(apiKey || '').trim();
  }

  const projectConfig: ProjectConfig = {
    model: String(model || DEFAULT_MODEL).trim(),
    format: String(format || 'custom'),
    instructions: instructions.trim(),
    temperature:
      typeof temperature === 'number' && !Number.isNaN(temperature)
        ? temperature
        : DEFAULT_TEMPERATURE,
    maxTokens:
      typeof maxTokens === 'number' && !Number.isNaN(maxTokens)
        ? Math.round(maxTokens)
        : DEFAULT_MAX_TOKENS,
  };

  const updatedConfig = upsertProjectConfig(existingConfig, repoRoot, projectConfig);
  updatedConfig.openrouterApiKey = globalApiKey;

  await saveGlobalConfig(resolvedConfigPath, updatedConfig);

  console.log(`Config saved to ${resolvedConfigPath}`);
  console.log(`Linked to repo ${repoRoot}`);
}
