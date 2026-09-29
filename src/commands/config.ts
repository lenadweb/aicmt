import {
  CONFIG_KEYS,
  ConfigKey,
  GlobalConfig,
  getRepoConfigPath,
  loadConfig,
  loadGlobalConfig,
  loadRepoConfig,
  resolveConfigPath,
  saveGlobalConfig,
  saveRepoConfig,
} from '../config';
import { getRepoRoot, isGitRepo } from '../git';

export type ConfigScope = 'global' | 'project' | 'repo';

interface ConfigCommandOptions {
  cwd: string;
  configPath?: string;
}

const NUMBER_KEYS: ConfigKey[] = ['temperature', 'maxTokens', 'count', 'timeout', 'historyExamples'];

function assertKey(key: string): ConfigKey {
  if (!CONFIG_KEYS.includes(key as ConfigKey)) {
    throw new Error(`Unknown config key "${key}". Known keys: ${CONFIG_KEYS.join(', ')}`);
  }
  return key as ConfigKey;
}

function assertScope(scope: string | undefined): ConfigScope {
  const value = scope ?? 'global';
  if (value !== 'global' && value !== 'project' && value !== 'repo') {
    throw new Error(`Unknown scope "${value}". Use global, project or repo.`);
  }
  return value;
}

/** Turns a command-line string into the value type the key expects. */
function parseValue(key: ConfigKey, raw: string): unknown {
  if (NUMBER_KEYS.includes(key)) {
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw new Error(`${key} must be a number.`);
    }
    return value;
  }

  if (key === 'ignore') {
    return raw.split(',').map((item) => item.trim()).filter(Boolean);
  }

  if (key === 'branchPrefix') {
    // Either a JSON object {"pattern": "...", "template": "..."} or just the pattern
    return raw.trim().startsWith('{') ? JSON.parse(raw) : { pattern: raw };
  }

  return raw;
}

function formatValue(key: ConfigKey, value: unknown): string {
  if (value === undefined) {
    return '(not set)';
  }
  if (key === 'apiKey' && typeof value === 'string') {
    return value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-4)}` : '****';
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

async function getRepoRootOrThrow(cwd: string): Promise<string> {
  if (!(await isGitRepo(cwd))) {
    throw new Error('Not a git repository. Run inside a git project.');
  }
  return getRepoRoot(cwd);
}

async function getRepoRootIfAny(cwd: string): Promise<string | undefined> {
  return (await isGitRepo(cwd)) ? getRepoRoot(cwd) : undefined;
}

/** Applies a change to one layer of one config file and saves it. */
async function updateLayer(
  { cwd, configPath }: ConfigCommandOptions,
  scope: ConfigScope,
  update: (layer: Record<string, unknown>) => void,
): Promise<string> {
  if (scope === 'repo') {
    const repoRoot = await getRepoRootOrThrow(cwd);
    const repoConfig: Record<string, unknown> = { ...(await loadRepoConfig(repoRoot)) };
    update(repoConfig);
    await saveRepoConfig(repoRoot, repoConfig);
    return getRepoConfigPath(repoRoot);
  }

  const repoRoot = scope === 'project' ? await getRepoRootOrThrow(cwd) : await getRepoRootIfAny(cwd);
  const globalPath = resolveConfigPath(repoRoot ?? cwd, configPath);
  const globalConfig: GlobalConfig = await loadGlobalConfig(globalPath, { allowMissing: true });

  if (scope === 'project') {
    const projectConfig: Record<string, unknown> = { ...globalConfig.projects[repoRoot as string] };
    update(projectConfig);
    globalConfig.projects[repoRoot as string] = projectConfig;
  } else {
    update(globalConfig as unknown as Record<string, unknown>);
  }

  await saveGlobalConfig(globalPath, globalConfig);
  return globalPath;
}

export async function runConfigSet(
  options: ConfigCommandOptions,
  key: string,
  rawValue: string,
  scopeName?: string,
): Promise<void> {
  const configKey = assertKey(key);
  const scope = assertScope(scopeName);
  if (configKey === 'apiKey' && scope === 'repo') {
    throw new Error('The API key cannot be stored in the repo config: it is usually committed.');
  }

  const value = parseValue(configKey, rawValue);
  const savedTo = await updateLayer(options, scope, (layer) => {
    if (configKey === 'apiKey') {
      delete layer.openrouterApiKey;
    }
    layer[configKey] = value;
  });

  console.log(`Set ${configKey} = ${formatValue(configKey, value)} (${scope}: ${savedTo})`);
}

export async function runConfigUnset(
  options: ConfigCommandOptions,
  key: string,
  scopeName?: string,
): Promise<void> {
  const configKey = assertKey(key);
  const scope = assertScope(scopeName);

  const savedTo = await updateLayer(options, scope, (layer) => {
    delete layer[configKey];
    if (configKey === 'apiKey') {
      delete layer.openrouterApiKey;
    }
  });

  console.log(`Removed ${configKey} (${scope}: ${savedTo})`);
}

export async function runConfigGet(options: ConfigCommandOptions, key: string): Promise<void> {
  const configKey = assertKey(key);
  const repoRoot = await getRepoRootOrThrow(options.cwd);
  const { config } = await loadConfig(repoRoot, { configPath: options.configPath });

  const value =
    configKey === 'timeout'
      ? config.timeoutMs / 1000
      : (config as unknown as Record<string, unknown>)[configKey];

  if (value !== undefined) {
    console.log(typeof value === 'string' ? value : JSON.stringify(value));
  }
}

export async function runConfigList(options: ConfigCommandOptions): Promise<void> {
  const repoRoot = await getRepoRootOrThrow(options.cwd);
  const { config, sources, globalConfigPath } = await loadConfig(repoRoot, {
    configPath: options.configPath,
  });

  console.log(`Global config: ${globalConfigPath}`);
  console.log(`Repo config:   ${getRepoConfigPath(repoRoot)}\n`);

  const values: Record<ConfigKey, unknown> = {
    ...config,
    timeout: config.timeoutMs / 1000,
  } as unknown as Record<ConfigKey, unknown>;

  const width = Math.max(...CONFIG_KEYS.map((key) => key.length));
  for (const key of CONFIG_KEYS) {
    const source = sources[key] ? ` [${sources[key]}]` : '';
    console.log(`${key.padEnd(width)}  ${formatValue(key, values[key])}${source}`);
  }
}

export async function runConfigPaths({ cwd, configPath }: ConfigCommandOptions): Promise<void> {
  const repoRoot = await getRepoRootIfAny(cwd);
  console.log(`global: ${resolveConfigPath(repoRoot ?? cwd, configPath)}`);
  if (repoRoot) {
    console.log(`repo:   ${getRepoConfigPath(repoRoot)}`);
  }
}
