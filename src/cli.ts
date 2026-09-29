import { access } from 'node:fs/promises';
import { Command, InvalidArgumentError } from 'commander';
import { getRepoConfigPath, parseCliOverrides, readEnvConfig, resolveConfigPath } from './config';
import { runCommit } from './commands/commit';
import {
  runConfigGet,
  runConfigList,
  runConfigPaths,
  runConfigSet,
  runConfigUnset,
} from './commands/config';
import { runDoctor } from './commands/doctor';
import { runHookInstall, runHookMessage, runHookStatus, runHookUninstall } from './commands/hook';
import { runInit } from './commands/init';
import { getRepoRoot, isGitRepo } from './git';

declare const __APP_VERSION__: string;

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** First run: nothing configured anywhere yet. */
async function isUnconfigured(cwd: string): Promise<boolean> {
  if (await fileExists(resolveConfigPath(cwd))) {
    return false;
  }
  if (readEnvConfig().apiKey) {
    return false;
  }
  if ((await isGitRepo(cwd)) && (await fileExists(getRepoConfigPath(await getRepoRoot(cwd))))) {
    return false;
  }
  return true;
}

function parseNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new InvalidArgumentError('Not a number.');
  }
  return parsed;
}

interface CommitCliOptions {
  config?: string;
  dryRun?: boolean;
  verbose?: boolean;
  yes?: boolean;
  all?: boolean;
  split?: boolean;
  splitHunks?: boolean;
  prefix?: string | false;
  model?: string;
  baseUrl?: string;
  lang?: string;
  instructions?: string;
  temperature?: number;
  maxTokens?: number;
  count?: number;
  timeout?: number;
}

export async function run(argv: string[] = process.argv): Promise<void> {
  const program = new Command();
  const cwd = process.cwd();

  program
    .name('aicmt')
    .description('AI-assisted git commits via OpenRouter or any OpenAI-compatible API')
    .version(__APP_VERSION__);

  program
    .command('init')
    .description('Set up aicmt interactively (global defaults, repo override or shared repo file)')
    .option('-c, --config <path>', 'Path to global config file')
    .action(async (options: { config?: string }) => {
      await runInit({ cwd, configPath: options.config });
    });

  program
    .command('commit', { isDefault: true })
    .description('Generate and create a commit for staged changes')
    .option('-c, --config <path>', 'Path to global config file')
    .option('-a, --all', 'Stage all changes before committing', false)
    .option('-y, --yes', 'Skip prompts: take the first message (stages all if nothing is staged)', false)
    .option('--dry-run', 'Show the chosen message without committing', false)
    .option('-v, --verbose', 'Show AI request and response logs', false)
    .option('-s, --split', 'Split changes into multiple logical commits (file-level)', false)
    .option('--split-hunks', 'Split changes into multiple commits (hunk-level, experimental)', false)
    .option('--prefix <string>', 'Prefix to add before commit message (e.g., "DEV-95: ")')
    .option('--no-prefix', 'Do not add any prefix (ignores prefix and branchPrefix settings)')
    .option('--model <id>', 'Model to use for this run')
    .option('--base-url <url>', 'OpenAI-compatible API base URL (e.g. http://localhost:11434/v1)')
    .option('-l, --lang <language>', 'Language of commit messages (e.g. English, Russian)')
    .option('-i, --instructions <text>', 'Commit message instructions for this run')
    .option('-t, --temperature <number>', 'Sampling temperature (0-2)', parseNumber)
    .option('--max-tokens <number>', 'Max output tokens per message', parseNumber)
    .option('-n, --count <number>', 'Number of message options to generate (1-10)', parseNumber)
    .option('--timeout <seconds>', 'AI request timeout in seconds', parseNumber)
    .action(async (options: CommitCliOptions) => {
      const overrides = parseCliOverrides({
        model: options.model,
        baseUrl: options.baseUrl,
        language: options.lang,
        instructions: options.instructions,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        count: options.count,
        timeout: options.timeout,
        prefix: typeof options.prefix === 'string' ? options.prefix : undefined,
      });

      await runCommit({
        cwd,
        configPath: options.config,
        dryRun: Boolean(options.dryRun),
        verbose: Boolean(options.verbose),
        yes: Boolean(options.yes),
        all: Boolean(options.all),
        split: Boolean(options.split),
        splitHunks: Boolean(options.splitHunks),
        noPrefix: options.prefix === false,
        overrides,
      });
    });

  const config = program
    .command('config')
    .description('Show or change settings')
    .option('-c, --config <path>', 'Path to global config file');
  const configOptions = () => ({ cwd, configPath: config.opts<{ config?: string }>().config });
  const scopeOption = '-s, --scope <scope>';
  const scopeDescription = 'global (default), project (this repo, private) or repo (.aicmtrc.json, shared)';

  config
    .command('list', { isDefault: true })
    .description('Show effective settings for this repository and where each comes from')
    .action(() => runConfigList(configOptions()));

  config
    .command('get <key>')
    .description('Print the effective value of a setting')
    .action((key: string) => runConfigGet(configOptions(), key));

  config
    .command('set <key> <value>')
    .description('Change a setting (ignore: comma-separated; branchPrefix: pattern or JSON)')
    .option(scopeOption, scopeDescription)
    .action((key: string, value: string, options: { scope?: string }) =>
      runConfigSet(configOptions(), key, value, options.scope),
    );

  config
    .command('unset <key>')
    .description('Remove a setting')
    .option(scopeOption, scopeDescription)
    .action((key: string, options: { scope?: string }) =>
      runConfigUnset(configOptions(), key, options.scope),
    );

  config
    .command('path')
    .description('Print config file locations')
    .action(() => runConfigPaths(configOptions()));

  const hook = program
    .command('hook')
    .description('Generate messages for a plain "git commit" via a prepare-commit-msg hook');

  hook
    .command('install')
    .description('Install the hook in this repository')
    .option('-f, --force', 'Overwrite an existing prepare-commit-msg hook', false)
    .action((options: { force?: boolean }) => runHookInstall({ cwd }, Boolean(options.force)));

  hook
    .command('uninstall')
    .description('Remove the hook')
    .action(() => runHookUninstall({ cwd }));

  hook
    .command('status', { isDefault: true })
    .description('Show whether the hook is installed')
    .action(() => runHookStatus({ cwd }));

  hook
    .command('run <messageFile> [source]', { hidden: true })
    .description('Called by the hook: write a generated message into the file')
    .action((messageFile: string, source?: string) => runHookMessage({ cwd }, messageFile, source));

  program
    .command('doctor')
    .description('Check git, config, API access and model')
    .option('-c, --config <path>', 'Path to global config file')
    .action(async (options: { config?: string }) => {
      if (!(await runDoctor({ cwd, configPath: options.config }))) {
        process.exitCode = 1;
      }
    });

  if (argv.length <= 2 && (await isUnconfigured(cwd))) {
    await runInit({ cwd });
    return;
  }

  await program.parseAsync(argv);
}
