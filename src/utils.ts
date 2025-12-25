import { execFile } from 'node:child_process';
import type { ExecFileOptions } from 'node:child_process';
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
