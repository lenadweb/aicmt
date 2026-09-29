import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  CONFIG_DIR_NAME,
  CONFIG_FILENAME,
  DEFAULT_BASE_URL,
  DEFAULT_COUNT,
  DEFAULT_HISTORY_EXAMPLES,
  DEFAULT_IGNORE,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  DEFAULT_TIMEOUT_SECONDS,
  MAX_COUNT,
  MAX_HISTORY_EXAMPLES,
  MAX_OUTPUT_TOKENS,
  MIN_OUTPUT_TOKENS,
  REPO_CONFIG_FILENAME,
} from './constants';

function isValidRegExp(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

const branchPrefixSchema = z
  .object({
    pattern: z.string().min(1).refine(isValidRegExp, 'branchPrefix.pattern is not a valid regular expression'),
    template: z.string().min(1).optional(),
  })
  .strict();

// Settings that are safe to share: allowed everywhere, including the repo config file
const settingsShape = {
  baseUrl: z.string().url().optional(),
  model: z.string().min(1).optional(),
  format: z.string().min(1).optional(),
  instructions: z.string().min(1).optional(),
  language: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  count: z.number().int().min(1).max(MAX_COUNT).optional(),
  timeout: z.number().positive().optional(),
  historyExamples: z.number().int().min(0).max(MAX_HISTORY_EXAMPLES).optional(),
  ignore: z.array(z.string().min(1)).optional(),
  prefix: z.string().min(1).optional(),
  branchPrefix: branchPrefixSchema.optional(),
};

const secretShape = {
  apiKey: z.string().min(1).optional(),
  // Legacy name of apiKey, still read for existing configs
  openrouterApiKey: z.string().min(1).optional(),
};

export const repoConfigSchema = z.object(settingsShape).strict();

const projectConfigSchema = z.object({ ...secretShape, ...settingsShape }).strict();

export const globalConfigSchema = projectConfigSchema
  .extend({
    projects: z.record(projectConfigSchema).default({}),
  })
  .strict();

export type RepoConfig = z.infer<typeof repoConfigSchema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type GlobalConfig = z.infer<typeof globalConfigSchema>;
export type BranchPrefix = z.infer<typeof branchPrefixSchema>;

/** Every user-facing setting: one layer of configuration. */
export type ConfigLayer = Omit<ProjectConfig, 'openrouterApiKey'>;
export type ConfigKey = keyof ConfigLayer;

export const CONFIG_KEYS: ConfigKey[] = [
  'apiKey',
  'baseUrl',
  'model',
  'format',
  'instructions',
  'language',
  'temperature',
  'maxTokens',
  'count',
  'timeout',
  'historyExamples',
  'ignore',
  'prefix',
  'branchPrefix',
];

export type ConfigSource = 'global' | 'project' | 'repo' | 'env' | 'cli' | 'default';

export interface ResolvedConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  format?: string;
  instructions: string;
  language?: string;
  temperature: number;
  maxTokens: number;
  count: number;
  timeoutMs: number;
  historyExamples: number;
  ignore: string[];
  prefix?: string;
  branchPrefix?: BranchPrefix;
}

export interface ResolvedConfigWithSources {
  config: ResolvedConfig;
  sources: Partial<Record<ConfigKey, ConfigSource>>;
}

export interface LoadConfigOptions {
  allowMissing?: boolean;
}

export function getDefaultConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim();
  const configDir = base
    ? path.join(base, CONFIG_DIR_NAME)
    : path.join(os.homedir(), '.config', CONFIG_DIR_NAME);
  return path.join(configDir, CONFIG_FILENAME);
}

export function resolveConfigPath(repoRoot: string, providedPath?: string): string {
  if (providedPath) {
    return path.isAbsolute(providedPath)
      ? providedPath
      : path.resolve(repoRoot, providedPath);
  }

  return getDefaultConfigPath();
}

export function getRepoConfigPath(repoRoot: string): string {
  return path.join(repoRoot, REPO_CONFIG_FILENAME);
}

function clampMaxTokens(value: number): number {
  return Math.min(MAX_OUTPUT_TOKENS, Math.max(MIN_OUTPUT_TOKENS, value));
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ');
}

/** Drops undefined values and maps the legacy key name. */
function toLayer(config: ProjectConfig | undefined): ConfigLayer {
  if (!config) {
    return {};
  }

  const { openrouterApiKey, ...rest } = config;
  const layer: ConfigLayer = { ...rest, apiKey: rest.apiKey ?? openrouterApiKey };
  return Object.fromEntries(
    Object.entries(layer).filter(([, value]) => value !== undefined),
  ) as ConfigLayer;
}

export function readEnvConfig(env: NodeJS.ProcessEnv = process.env): ConfigLayer {
  const pick = (...names: string[]) =>
    names.map((name) => env[name]?.trim()).find((value) => value) || undefined;

  return toLayer({
    apiKey: pick('AICMT_API_KEY', 'OPENROUTER_API_KEY'),
    baseUrl: pick('AICMT_BASE_URL'),
    model: pick('AICMT_MODEL'),
    language: pick('AICMT_LANGUAGE'),
  });
}

export interface ConfigLayers {
  global: GlobalConfig;
  repoRoot: string;
  repo?: RepoConfig;
  env?: ConfigLayer;
  cli?: ConfigLayer;
}

/**
 * Merges configuration layers, later ones winning:
 * global defaults < global per-project override < repo file < environment < CLI flags.
 * `ignore` extends the built-in list instead of replacing it.
 */
export function resolveConfig({
  global,
  repoRoot,
  repo,
  env,
  cli,
}: ConfigLayers): ResolvedConfigWithSources {
  const { projects = {}, ...globalDefaults } = global;
  const layers: Array<[ConfigSource, ConfigLayer]> = [
    ['global', toLayer(globalDefaults)],
    ['project', toLayer(projects[repoRoot])],
    ['repo', toLayer(repo)],
    ['env', env ?? {}],
    ['cli', toLayer(cli)],
  ];

  const merged: ConfigLayer = {};
  const sources: ResolvedConfigWithSources['sources'] = {};
  const extraIgnore: string[] = [];

  for (const [source, layer] of layers) {
    for (const key of CONFIG_KEYS) {
      const value = layer[key];
      if (value === undefined) {
        continue;
      }
      if (key === 'ignore') {
        extraIgnore.push(...(value as string[]));
      } else {
        (merged as Record<string, unknown>)[key] = value;
      }
      sources[key] = source;
    }
  }

  const baseUrl = (merged.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const { apiKey, model, instructions } = merged;

  const missing: string[] = [];
  if (!model) {
    missing.push('model');
  }
  if (!instructions) {
    missing.push('instructions');
  }
  if (!apiKey && baseUrl === DEFAULT_BASE_URL) {
    missing.push('apiKey (or AICMT_API_KEY / OPENROUTER_API_KEY)');
  }
  if (!model || !instructions || missing.length > 0) {
    throw new Error(
      `Missing ${missing.join(', ')} in config. Run aicmt init to set defaults.`,
    );
  }

  for (const key of ['baseUrl', 'temperature', 'maxTokens', 'count', 'timeout', 'historyExamples'] as const) {
    sources[key] = sources[key] ?? 'default';
  }

  return {
    config: {
      apiKey,
      baseUrl,
      model,
      format: merged.format,
      instructions,
      language: merged.language,
      temperature: merged.temperature ?? DEFAULT_TEMPERATURE,
      maxTokens: clampMaxTokens(merged.maxTokens ?? DEFAULT_MAX_TOKENS),
      count: merged.count ?? DEFAULT_COUNT,
      timeoutMs: (merged.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
      historyExamples: merged.historyExamples ?? DEFAULT_HISTORY_EXAMPLES,
      ignore: [...new Set([...DEFAULT_IGNORE, ...extraIgnore])],
      prefix: merged.prefix,
      branchPrefix: merged.branchPrefix,
    },
    sources,
  };
}

/** Validates CLI overrides with the same rules as config files. */
export function parseCliOverrides(values: ConfigLayer): ConfigLayer {
  const result = projectConfigSchema.safeParse(toLayer(values));
  if (!result.success) {
    throw new Error(`Invalid option: ${formatIssues(result.error)}`);
  }
  return toLayer(result.data);
}

async function readJsonFile(filePath: string): Promise<unknown | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in config: ${filePath}`);
  }
}

export async function loadGlobalConfig(
  configPath: string,
  options: LoadConfigOptions = {},
): Promise<GlobalConfig> {
  const parsed = await readJsonFile(configPath);
  if (parsed === undefined) {
    if (options.allowMissing) {
      return globalConfigSchema.parse({});
    }
    throw new Error(`Global config not found at ${configPath}`);
  }

  const result = globalConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid config ${configPath}: ${formatIssues(result.error)}`);
  }

  return result.data;
}

export async function loadRepoConfig(repoRoot: string): Promise<RepoConfig | undefined> {
  const configPath = getRepoConfigPath(repoRoot);
  const parsed = await readJsonFile(configPath);
  if (parsed === undefined) {
    return undefined;
  }

  if (parsed && typeof parsed === 'object' && ('apiKey' in parsed || 'openrouterApiKey' in parsed)) {
    throw new Error(
      `${REPO_CONFIG_FILENAME} must not contain an API key: it is usually committed. ` +
        'Use AICMT_API_KEY or the global config instead.',
    );
  }

  const result = repoConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid config ${configPath}: ${formatIssues(result.error)}`);
  }

  return result.data;
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export async function saveGlobalConfig(
  configPath: string,
  config: GlobalConfig,
): Promise<void> {
  const result = globalConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Refusing to write invalid config: ${formatIssues(result.error)}`);
  }

  await writeJsonFile(configPath, result.data);
}

export async function saveRepoConfig(repoRoot: string, config: RepoConfig): Promise<void> {
  const result = repoConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Refusing to write invalid config: ${formatIssues(result.error)}`);
  }

  await writeJsonFile(getRepoConfigPath(repoRoot), result.data);
}

export interface LoadedConfig extends ResolvedConfigWithSources {
  globalConfigPath: string;
}

/** Loads every layer for a repository and resolves the effective config. */
export async function loadConfig(
  repoRoot: string,
  options: { configPath?: string; cli?: ConfigLayer } = {},
): Promise<LoadedConfig> {
  const globalConfigPath = resolveConfigPath(repoRoot, options.configPath);
  const global = await loadGlobalConfig(globalConfigPath, { allowMissing: true });
  const repo = await loadRepoConfig(repoRoot);

  return {
    ...resolveConfig({ global, repoRoot, repo, env: readEnvConfig(), cli: options.cli }),
    globalConfigPath,
  };
}
