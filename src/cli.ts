import { Command } from 'commander';
import { runCommit } from './commands/commit';
import { runInit } from './commands/init';

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
    .action(
      async (options: {
        config?: string;
        dryRun?: boolean;
        verbose?: boolean;
        yes?: boolean;
      }) => {
      await runCommit({
        cwd: process.cwd(),
        configPath: options.config,
        dryRun: Boolean(options.dryRun),
        verbose: Boolean(options.verbose),
        yes: Boolean(options.yes),
      });
    },
    );

  await program.parseAsync(argv);
}
