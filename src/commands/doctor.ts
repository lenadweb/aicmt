import {
  getRepoConfigPath,
  loadGlobalConfig,
  loadRepoConfig,
  readEnvConfig,
  resolveConfig,
  resolveConfigPath,
  ResolvedConfig,
} from '../config';
import { getCurrentBranch, getRepoRoot, isGitRepo } from '../git';
import { prefixFromBranch } from './commit';

interface DoctorOptions {
  cwd: string;
  configPath?: string;
}

type CheckResult = { ok: boolean; warn?: boolean; message: string };

function report({ ok, warn, message }: CheckResult): void {
  const mark = !ok ? '✗' : warn ? '!' : '✓';
  console.log(`${mark} ${message}`);
}

async function checkApi(config: ResolvedConfig): Promise<CheckResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  const headers: Record<string, string> = {};
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  try {
    const response = await fetch(`${config.baseUrl}/models`, { headers, signal: controller.signal });
    if (!response.ok) {
      return [{ ok: false, message: `API ${config.baseUrl} answered ${response.status}` }];
    }

    const results: CheckResult[] = [{ ok: true, message: `API reachable: ${config.baseUrl}` }];
    const body = (await response.json().catch(() => undefined)) as
      | { data?: Array<{ id?: string }> }
      | undefined;
    const ids = body?.data?.map((model) => model.id).filter(Boolean) ?? [];
    if (ids.length > 0) {
      results.push(
        ids.includes(config.model)
          ? { ok: true, message: `Model available: ${config.model}` }
          : { ok: true, warn: true, message: `Model "${config.model}" is not in the provider's model list` },
      );
    }

    // OpenRouter lists models without auth, so check the key separately
    if (config.baseUrl.startsWith('https://openrouter.ai/')) {
      const keyResponse = await fetch(`${config.baseUrl}/key`, { headers, signal: controller.signal });
      results.push(
        keyResponse.ok
          ? { ok: true, message: 'API key accepted' }
          : { ok: false, message: `API key rejected (${keyResponse.status})` },
      );
    }

    return results;
  } catch (error) {
    const reason = controller.signal.aborted
      ? 'timed out'
      : error instanceof Error
        ? error.message
        : String(error);
    return [{ ok: false, message: `API ${config.baseUrl} unreachable: ${reason}` }];
  } finally {
    clearTimeout(timer);
  }
}

/** Checks the setup step by step and prints what is wrong. Returns false on any failure. */
export async function runDoctor({ cwd, configPath }: DoctorOptions): Promise<boolean> {
  const results: CheckResult[] = [];
  const add = (result: CheckResult) => {
    results.push(result);
    report(result);
  };

  if (!(await isGitRepo(cwd))) {
    add({ ok: false, message: 'Not inside a git repository' });
    return false;
  }
  const repoRoot = await getRepoRoot(cwd);
  add({ ok: true, message: `Git repository: ${repoRoot}` });

  const globalPath = resolveConfigPath(repoRoot, configPath);
  let global;
  try {
    global = await loadGlobalConfig(globalPath, { allowMissing: true });
    add({ ok: true, message: `Global config: ${globalPath}` });
  } catch (error) {
    add({ ok: false, message: (error as Error).message });
    return false;
  }

  let repo;
  try {
    repo = await loadRepoConfig(repoRoot);
    add({
      ok: true,
      message: repo ? `Repo config: ${getRepoConfigPath(repoRoot)}` : 'Repo config: none',
    });
  } catch (error) {
    add({ ok: false, message: (error as Error).message });
    return false;
  }

  let config: ResolvedConfig;
  try {
    ({ config } = resolveConfig({ global, repoRoot, repo, env: readEnvConfig() }));
    add({ ok: true, message: `Config complete (model: ${config.model})` });
  } catch (error) {
    add({ ok: false, message: (error as Error).message });
    return false;
  }

  if (config.branchPrefix) {
    const branch = await getCurrentBranch(repoRoot);
    const prefix = branch ? prefixFromBranch(branch, config.branchPrefix) : undefined;
    add({
      ok: true,
      warn: !prefix,
      message: prefix
        ? `Branch prefix for "${branch}": "${prefix}"`
        : `Branch prefix pattern does not match the current branch (${branch ?? 'detached HEAD'})`,
    });
  }

  (await checkApi(config)).forEach(add);

  return results.every((result) => result.ok);
}
