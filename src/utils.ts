import { execFile, spawn } from 'node:child_process';
import type { ExecFileOptions } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function runCommand(
  command: string,
  args: string[],
  options: ExecFileOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(command, args, {
    ...options,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';

  return {
    stdout: stdout.trimEnd(),
    stderr: stderr.trimEnd(),
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Converts a gitignore-like glob to a RegExp: `*` stays within a path segment, `**` crosses
 * segments, `?` is one character. A pattern without a slash matches the file name at any depth.
 */
export function globToRegExp(pattern: string): RegExp {
  let glob = pattern.trim();
  const anchored = glob.includes('/') && !glob.endsWith('/') ? true : glob.startsWith('/');
  glob = glob.replace(/^\//, '');
  if (glob.endsWith('/')) {
    glob += '**';
  }

  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      const slashAfter = glob[i + 2] === '/';
      source += slashAfter ? '(?:.*/)?' : '.*';
      i += slashAfter ? 2 : 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }

  return new RegExp(anchored ? `^${source}$` : `(?:^|/)${source}$`);
}

export function createPathMatcher(patterns: string[]): (filePath: string) => boolean {
  const regexps = patterns.map(globToRegExp);
  return (filePath) => regexps.some((re) => re.test(filePath));
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Shows a spinner on stderr while the task runs (only in an interactive terminal). */
export async function withSpinner<T>(text: string, task: () => Promise<T>): Promise<T> {
  const stream = process.stderr;
  if (!stream.isTTY) {
    return task();
  }

  let frame = 0;
  const render = () => stream.write(`\r${SPINNER_FRAMES[frame++ % SPINNER_FRAMES.length]} ${text}`);
  render();
  const timer = setInterval(render, 80);

  try {
    return await task();
  } finally {
    clearInterval(timer);
    stream.write('\r\x1b[K');
  }
}

/** Opens the text in the user's editor and returns the edited text without `#` comment lines. */
export async function editInEditor(editor: string, text: string, cwd: string): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aicmt-edit-'));
  const filePath = path.join(tempDir, 'COMMIT_EDITMSG');
  await fs.writeFile(
    filePath,
    `${text}\n\n# Edit the commit message. Lines starting with '#' are ignored.\n`,
    'utf8',
  );

  try {
    await new Promise<void>((resolve, reject) => {
      // The editor setting may contain arguments (e.g. "code --wait"), so run it through the shell
      const child = spawn(`${editor} "${filePath}"`, { cwd, shell: true, stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`Editor exited with code ${code}`)),
      );
    });

    const edited = await fs.readFile(filePath, 'utf8');
    return edited
      .split('\n')
      .filter((line) => !line.startsWith('#'))
      .join('\n')
      .trim();
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
