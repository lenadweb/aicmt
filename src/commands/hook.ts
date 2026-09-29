import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../config';
import { generateCommitMessages } from '../ai';
import { getGitPath, getRepoRoot, getStagedDiff, isGitRepo } from '../git';
import { withSpinner } from '../utils';
import { applyPrefix, buildAiSettings, resolvePrefix } from './commit';

const HOOK_NAME = 'prepare-commit-msg';
const HOOK_MARKER = '# aicmt prepare-commit-msg hook';

interface HookOptions {
  cwd: string;
  configPath?: string;
}

async function getHookPath(cwd: string): Promise<string> {
  if (!(await isGitRepo(cwd))) {
    throw new Error('Not a git repository. Run inside a git project.');
  }
  // Respects core.hooksPath and worktrees
  return path.resolve(cwd, await getGitPath(cwd, `hooks/${HOOK_NAME}`));
}

async function readHook(hookPath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(hookPath, 'utf8');
  } catch {
    return undefined;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The hook calls this exact node binary and script when they still exist: git GUIs and IDEs
 * often run hooks without the shell PATH (nvm, volta). Otherwise it falls back to `aicmt`.
 */
async function buildHookScript(): Promise<string> {
  const script = await fs.realpath(process.argv[1]).catch(() => process.argv[1]);
  const node = shellQuote(process.execPath);
  const cli = shellQuote(script);

  return `#!/bin/sh
${HOOK_MARKER}
# Fills in the commit message for a plain "git commit". Remove with: aicmt hook uninstall

# Not when the message is already given: -m/-F, merges, squashes, --amend/-c/-C
case "$2" in message|merge|squash|commit) exit 0 ;; esac
[ -n "$AICMT_SKIP_HOOK" ] && exit 0

if [ -x ${node} ] && [ -f ${cli} ]; then
  ${node} ${cli} hook run "$1" "$2" || true
elif command -v aicmt >/dev/null 2>&1; then
  aicmt hook run "$1" "$2" || true
fi
exit 0
`;
}

export async function runHookInstall({ cwd }: HookOptions, force = false): Promise<void> {
  const hookPath = await getHookPath(cwd);
  const existing = await readHook(hookPath);

  if (existing !== undefined && !existing.includes(HOOK_MARKER) && !force) {
    throw new Error(
      `${hookPath} already exists and was not created by aicmt. ` +
        'Add "aicmt hook run $1" to it yourself, or overwrite it with --force.',
    );
  }

  await fs.mkdir(path.dirname(hookPath), { recursive: true });
  await fs.writeFile(hookPath, await buildHookScript(), { mode: 0o755 });
  await fs.chmod(hookPath, 0o755);

  console.log(`Installed ${hookPath}`);
  console.log('Now a plain "git commit" (also from IDEs) opens the editor with an AI message.');
}

export async function runHookUninstall({ cwd }: HookOptions): Promise<void> {
  const hookPath = await getHookPath(cwd);
  const existing = await readHook(hookPath);

  if (existing === undefined) {
    console.log('No hook installed.');
    return;
  }
  if (!existing.includes(HOOK_MARKER)) {
    throw new Error(`${hookPath} was not created by aicmt, leaving it untouched.`);
  }

  await fs.unlink(hookPath);
  console.log(`Removed ${hookPath}`);
}

export async function runHookStatus({ cwd }: HookOptions): Promise<void> {
  const hookPath = await getHookPath(cwd);
  const existing = await readHook(hookPath);

  if (existing === undefined) {
    console.log(`Not installed (${hookPath})`);
  } else if (existing.includes(HOOK_MARKER)) {
    console.log(`Installed (${hookPath})`);
  } else {
    console.log(`A different ${HOOK_NAME} hook exists (${hookPath})`);
  }
}

/** Text the user would commit: git's comments and the `commit -v` diff below the scissors don't count. */
function hasOwnText(content: string): boolean {
  const scissors = content.search(/^# -+ >8 -+$/m);
  const message = scissors === -1 ? content : content.slice(0, scissors);
  return message.split('\n').some((line) => line.trim() && !line.startsWith('#'));
}

/**
 * Called by the hook: writes one generated message above git's comment lines.
 * Never fails the commit: on any error git just opens the editor as usual.
 */
export async function runHookMessage(
  { cwd, configPath }: HookOptions,
  messageFile: string,
  source?: string,
): Promise<void> {
  try {
    const filePath = path.resolve(cwd, messageFile);
    const current = await fs.readFile(filePath, 'utf8').catch(() => '');

    // A commit.template with real text is the user's own message skeleton: leave it alone
    if (source === 'template' && hasOwnText(current)) {
      return;
    }

    const repoRoot = await getRepoRoot(cwd);
    const diff = await getStagedDiff(repoRoot);
    if (!diff.trim()) {
      return;
    }

    const { config } = await loadConfig(repoRoot, { configPath });
    const prefix = await resolvePrefix(repoRoot, config);
    const ai = await buildAiSettings(repoRoot, config, prefix);

    const [message] = await withSpinner('aicmt: generating commit message...', () =>
      generateCommitMessages({ settings: ai, diff, count: 1 }),
    );
    if (!message) {
      return;
    }

    // Keep git's own content (comments, verbose diff) below the generated message
    await fs.writeFile(filePath, `${applyPrefix(message, prefix)}\n${current}`, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`aicmt: could not generate a message (${reason})`);
  }
}
