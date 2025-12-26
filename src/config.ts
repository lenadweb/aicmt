import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  CONFIG_DIR_NAME,
  CONFIG_FILENAME,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  MAX_OUTPUT_TOKENS,
  MIN_OUTPUT_TOKENS,
} from './constants';

const sharedConfigSchema = z
  .object({
    openrouterApiKey: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    format: z.string().min(1).optional(),
    instructions: z.string().min(1).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
  })
  .strict();

const projectConfigSchema = sharedConfigSchema;

export const globalConfigSchema = sharedConfigSchema
  .extend({
    projects: z.record(projectConfigSchema).default({}),
  })
  .strict();

export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type GlobalConfig = z.infer<typeof globalConfigSchema>;
export type GlobalDefaults = Omit<GlobalConfig, 'projects'>;

export interface ResolvedConfig {
  openrouterApiKey: string;
  model: string;
  format: string;
  instructions: string;
  temperature: number;
  maxTokens: number;
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

function clampMaxTokens(value: number): number {
  if (value < MIN_OUTPUT_TOKENS) {
    return MIN_OUTPUT_TOKENS;
  }

  if (value > MAX_OUTPUT_TOKENS) {
    return MAX_OUTPUT_TOKENS;
  }

  return value;
}

function applyDefaults(config: {
  openrouterApiKey: string;
  model: string;
  format: string;
  instructions: string;
  temperature?: number;
  maxTokens?: number;
}): ResolvedConfig {
  return {
    openrouterApiKey: config.openrouterApiKey,
    model: config.model,
    format: config.format,
    instructions: config.instructions,
    temperature:
      typeof config.temperature === 'number'
        ? config.temperature
        : DEFAULT_TEMPERATURE,
    maxTokens:
      typeof config.maxTokens === 'number'
        ? clampMaxTokens(config.maxTokens)
        : DEFAULT_MAX_TOKENS,
  };
}

export function resolveProjectConfig(
  globalConfig: GlobalConfig,
  repoRoot: string,
): ResolvedConfig {
  const { projects = {}, ...defaults } = globalConfig;
  const projectConfig = projects[repoRoot] ?? {};
  const merged = { ...defaults, ...projectConfig };

  const missing: string[] = [];
  if (!merged.openrouterApiKey) {
    missing.push('openrouterApiKey');
  }
  if (!merged.model) {
    missing.push('model');
  }
  if (!merged.format) {
    missing.push('format');
  }
  if (!merged.instructions) {
    missing.push('instructions');
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing ${missing.join(', ')} in config. Run aicmt init to set defaults.`,
    );
  }

  return applyDefaults({
    openrouterApiKey: merged.openrouterApiKey,
    model: merged.model,
    format: merged.format,
    instructions: merged.instructions,
    temperature: merged.temperature,
    maxTokens: merged.maxTokens,
  });
}

export async function loadGlobalConfig(
  configPath: string,
  options: LoadConfigOptions = {},
): Promise<GlobalConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (error) {
    if (options.allowMissing) {
      return globalConfigSchema.parse({});
    }
    throw new Error(`Global config not found at ${configPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in config: ${configPath}`);
  }

  const result = globalConfigSchema.safeParse(parsed);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => issue.message)
      .join('; ');
    throw new Error(`Invalid config: ${message}`);
  }

  return result.data;
}

export async function saveGlobalConfig(
  configPath: string,
  config: GlobalConfig,
): Promise<void> {
  const result = globalConfigSchema.safeParse(config);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => issue.message)
      .join('; ');
    throw new Error(`Refusing to write invalid config: ${message}`);
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const json = `${JSON.stringify(result.data, null, 2)}\n`;
  await fs.writeFile(configPath, json, 'utf8');
}
