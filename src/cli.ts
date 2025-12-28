import { access } from 'node:fs/promises';
import { Command } from 'commander';
import { resolveConfigPath } from './config';
import { runCommit } from './commands/commit';
import { runInit } from './commands/init';

async function configExists(configPath: string): Promise<boolean> {
  try {
    await access(configPath);
    return true;
  } catch (error) {
    return false;
  }
}

export async function run(argv: string[] = process.argv): Promise<void> {
  const program = new Command();

  program
    .name('aicmt')
    .description('AI-assisted git commits via OpenRouter')
    .version('0.1.0');

  program
    .command('init')
    .description('Initialize aicmt in this repository')
    .option('-c, --config <path>', 'Path to global config file')
    .action(async (options: { config?: string }) => {
      await runInit({ cwd: process.cwd(), configPath: options.config });
    });

  program
    .command('commit', { isDefault: true })
    .description('Generate and create a commit for staged changes')
    .option('-c, --config <path>', 'Path to global config file')
    .option('--dry-run', 'Show the chosen message without committing', false)
    .option('-v, --verbose', 'Show AI request and response logs', false)
    .option('-y, --yes', 'Skip prompts: stage all, pick first message', false)
    .option('-s, --split', 'Split changes into multiple logical commits', false)
    .action(
      async (options: {
        config?: string;
        dryRun?: boolean;
        verbose?: boolean;
        yes?: boolean;
        split?: boolean;
      }) => {
      await runCommit({
        cwd: process.cwd(),
        configPath: options.config,
        dryRun: Boolean(options.dryRun),
        verbose: Boolean(options.verbose),
        yes: Boolean(options.yes),
        split: Boolean(options.split),
      });
    },
    );

  if (argv.length <= 2) {
    const configPath = resolveConfigPath(process.cwd());
    if (!(await configExists(configPath))) {
      await runInit({ cwd: process.cwd() });
      return;
    }
  }

  await program.parseAsync(argv);
}
