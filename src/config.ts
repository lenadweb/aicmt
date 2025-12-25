import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { CONFIG_FILENAME, DEFAULT_MAX_TOKENS, DEFAULT_TEMPERATURE } from './constants';

export const configSchema = z
  .object({
    openrouterApiKey: z.string().min(1),
    model: z.string().min(1),
    format: z.string().min(1),
    instructions: z.string().min(1),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;

export type ResolvedConfig = Omit<Config, 'temperature' | 'maxTokens'> & {
  temperature: number;
  maxTokens: number;
};

export function resolveConfigPath(repoRoot: string, providedPath?: string): string {
  if (providedPath) {
    return path.isAbsolute(providedPath)
      ? providedPath
      : path.resolve(repoRoot, providedPath);
  }

  return path.join(repoRoot, CONFIG_FILENAME);
}

export function applyDefaults(config: Config): ResolvedConfig {
  return {
    ...config,
    temperature:
      typeof config.temperature === 'number'
        ? config.temperature
        : DEFAULT_TEMPERATURE,
    maxTokens:
      typeof config.maxTokens === 'number' ? config.maxTokens : DEFAULT_MAX_TOKENS,
  };
}

export async function loadConfig(configPath: string): Promise<ResolvedConfig> {
  let raw;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (error) {
    throw new Error(`Config not found at ${configPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in config: ${configPath}`);
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => issue.message)
      .join('; ');
    throw new Error(`Invalid config: ${message}`);
  }

  return applyDefaults(result.data);
}

export async function saveConfig(configPath: string, config: Config): Promise<void> {
  const result = configSchema.safeParse(config);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => issue.message)
      .join('; ');
    throw new Error(`Refusing to write invalid config: ${message}`);
  }

  const json = `${JSON.stringify(result.data, null, 2)}\n`;
  await fs.writeFile(configPath, json, 'utf8');
}
