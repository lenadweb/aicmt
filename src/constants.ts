export const CONFIG_DIR_NAME = 'aicmt';
export const CONFIG_FILENAME = 'config.json';
export const REPO_CONFIG_FILENAME = '.aicmtrc.json';
export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_MODEL = 'openai/gpt-4o-mini';
export const DEFAULT_TEMPERATURE = 0.2;
export const DEFAULT_MAX_TOKENS = 120;
export const DEFAULT_COUNT = 3;
export const MAX_COUNT = 10;
export const DEFAULT_TIMEOUT_SECONDS = 60;
export const DEFAULT_HISTORY_EXAMPLES = 10;
export const MAX_HISTORY_EXAMPLES = 50;
export const MIN_OUTPUT_TOKENS = 32;
export const MAX_OUTPUT_TOKENS = 512;

// Always hidden from the AI: noisy, generated and rarely meaningful for a commit message
export const DEFAULT_IGNORE = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'composer.lock',
  'Gemfile.lock',
  'go.sum',
  '*.min.js',
  '*.min.css',
  '*.map',
];
