import type { ResolvedConfig } from './config';
import { extractFileFromDiffHeader } from './git';
import { createPathMatcher, sleep } from './utils';

/** Everything needed to talk to the model. */
export type AiSettings = Pick<
  ResolvedConfig,
  | 'apiKey'
  | 'baseUrl'
  | 'model'
  | 'instructions'
  | 'language'
  | 'temperature'
  | 'maxTokens'
  | 'timeoutMs'
  | 'ignore'
> & {
  /** Recent commit messages of the repository, used as style examples. */
  examples?: string[];
  /** A prefix is added after generation, so the model must not write one. */
  prefixAddedLater?: boolean;
};

interface CompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const LARGE_NEW_FILE_LINE_LIMIT = 400;
const LARGE_NEW_FILE_HEAD_LINES = 120;
const LARGE_NEW_FILE_TAIL_LINES = 60;
const SPLIT_TOKENS_PER_ITEM = 40;
const SPLIT_MAX_TOKENS_CAP = 8000;

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }

  return trimmed.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
}

/**
 * Parses a JSON array from a model reply, tolerating code fences, surrounding prose
 * and a wrapper object like {"commits": [...]}.
 */
function parseJsonArrayLoose(text: string): unknown[] | null {
  const cleaned = stripCodeFences(text);
  const candidates = [cleaned];
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start !== -1 && end > start) {
    candidates.push(cleaned.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (Array.isArray(parsed)) {
        return parsed;
      }
      if (parsed && typeof parsed === 'object') {
        const arrays = Object.values(parsed).filter(Array.isArray);
        if (arrays.length === 1) {
          return arrays[0] as unknown[];
        }
      }
    } catch {
      // try next candidate
    }
  }

  return null;
}

function parseJsonArray(text: string): string[] | null {
  const parsed = parseJsonArrayLoose(text);
  if (!parsed) {
    return null;
  }

  const strings = parsed
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);

  return strings.length ? strings : null;
}

function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*\d.\)\s]+/, '').trim())
    .filter(Boolean);
}

function splitDiffBlocks(diff: string): string[][] {
  const lines = diff.split('\n');
  const blocks: string[][] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current.length > 0) {
        blocks.push(current);
      }
      current = [line];
      continue;
    }

    current.push(line);
  }

  if (current.length > 0) {
    blocks.push(current);
  }

  return blocks;
}

function isNewFileBlock(block: string[]): boolean {
  return (
    block.some((line) => line.startsWith('new file mode')) ||
    block.some((line) => line.startsWith('index 0000000..'))
  );
}

function compressLargeNewFiles(diff: string): string {
  if (!diff.trim()) {
    return diff;
  }

  const blocks = splitDiffBlocks(diff);
  const compressed = blocks.map((block) => {
    if (!isNewFileBlock(block)) {
      return block;
    }

    const hunkStart = block.findIndex((line) => line.startsWith('@@'));
    if (hunkStart === -1) {
      return block;
    }

    const header = block.slice(0, hunkStart + 1);
    const content = block.slice(hunkStart + 1);
    const addedLineCount = content.filter(
      (line) => line.startsWith('+') && !line.startsWith('+++'),
    ).length;

    if (addedLineCount <= LARGE_NEW_FILE_LINE_LIMIT) {
      return block;
    }

    const head = content.slice(0, LARGE_NEW_FILE_HEAD_LINES);
    const tail = content.slice(-LARGE_NEW_FILE_TAIL_LINES);

    if (head.length + tail.length >= content.length) {
      return block;
    }

    const omitted = content.length - head.length - tail.length;
    const marker = `+... [truncated ${omitted} lines from large new file] ...`;

    return [...header, ...head, marker, ...tail];
  });

  return compressed.flat().join('\n');
}

/** Replaces the content of ignored files with a marker, keeping their headers. */
function omitIgnoredFiles(diff: string, ignore: string[]): string {
  if (ignore.length === 0) {
    return diff;
  }

  const isIgnored = createPathMatcher(ignore);
  return splitDiffBlocks(diff)
    .map((block) => {
      if (!block[0]?.startsWith('diff --git ') || !isIgnored(extractFileFromDiffHeader(block[0]))) {
        return block;
      }
      const hunkStart = block.findIndex(
        (line) => line.startsWith('@@') || line.startsWith('GIT binary patch'),
      );
      const header = hunkStart === -1 ? block : block.slice(0, hunkStart);
      return [...header, '[content omitted: file matches an ignore pattern]'];
    })
    .flat()
    .join('\n');
}

/** Diff as sent to the model: ignored files hidden, huge new files shortened. */
function prepareDiff(diff: string, ignore: string[]): string {
  const trimmed = diff.trim();
  return trimmed ? compressLargeNewFiles(omitIgnoredFiles(trimmed, ignore)) : '[No diff available]';
}

function formatInstructions({ instructions, language, examples, prefixAddedLater }: AiSettings): string {
  const parts = [instructions];

  if (language) {
    parts.push(`Write commit messages in ${language}.`);
  }

  if (prefixAddedLater) {
    parts.push('Do not add ticket ids or similar prefixes: they are added automatically.');
  }

  if (examples && examples.length > 0) {
    parts.push(
      '',
      'Recent commit messages in this repository. Match their style (format, casing, length, language) where it does not conflict with the instructions above. Do not copy their content:',
      ...examples.map((example) => `- ${example}`),
    );
  }

  return parts.join('\n');
}

function normalizeMessages(messages: string[], count: number): string[] {
  const unique = [...new Set(messages)];
  if (unique.length === 0) {
    throw new Error('AI returned no commit messages');
  }

  return unique.slice(0, count);
}

export interface GenerateCommitMessagesInput {
  settings: AiSettings;
  diff: string;
  count: number;
  onDebug?: (info: AiDebugInfo) => void;
}

export interface CommitGroup {
  files: string[];
  message: string;
}

export interface HunkCommitGroup {
  hunkIds: string[];  // e.g., ["file.ts:1", "file.ts:2", "other.ts:1"]
  message: string;
}

export interface HunkInfo {
  id: string;
  file: string;
  summary: string;
}

export interface GenerateCommitGroupsInput {
  settings: AiSettings;
  diff: string;
  files: string[];
  onDebug?: (info: AiDebugInfo) => void;
}

export interface GenerateHunkGroupsInput {
  settings: AiSettings;
  hunks: HunkInfo[];
  fullDiff: string;
  onDebug?: (info: AiDebugInfo) => void;
}

export interface AiDebugInfo {
  stage: 'request' | 'response';
  prompt: string;
  payload: Record<string, unknown>;
  responseText?: string;
  status?: number;
}

interface CompletionRequest {
  settings: AiSettings;
  systemContent: string;
  prompt: string;
  maxTokens: number;
  onDebug?: (info: AiDebugInfo) => void;
}

function describeErrorResponse(status: number, responseText: string): string {
  try {
    const parsed = JSON.parse(responseText) as { error?: { message?: string } | string };
    const message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
    if (message) {
      return `AI API error ${status}: ${message}`;
    }
  } catch {
    // not JSON: fall through to the raw text
  }
  return `AI API error ${status}: ${responseText.slice(0, 500)}`;
}

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  const seconds = Number(retryAfter);
  if (retryAfter && Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 30_000);
  }
  return 1000 * 2 ** (attempt - 1);
}

/**
 * Sends one chat completion request to an OpenAI-compatible API and returns the text of the
 * first choice. Timeouts, network errors, rate limits and 5xx responses are retried.
 */
async function requestCompletion({
  settings,
  systemContent,
  prompt,
  maxTokens,
  onDebug,
}: CompletionRequest): Promise<string> {
  const payload: Record<string, unknown> = {
    model: settings.model,
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user', content: prompt },
    ],
    temperature: settings.temperature,
    max_tokens: maxTokens,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://aicmt.local',
    'X-Title': 'aicmt',
  };
  if (settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`;
  }

  onDebug?.({ stage: 'request', prompt, payload });

  for (let attempt = 1; ; attempt++) {
    const canRetry = attempt < MAX_ATTEMPTS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs);

    let status: number;
    let retryAfter: string | null;
    let responseText: string;
    try {
      const response = await fetch(`${settings.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      status = response.status;
      retryAfter = response.headers.get('retry-after');
      responseText = await response.text();
    } catch (error) {
      const reason = controller.signal.aborted
        ? `request timed out after ${settings.timeoutMs / 1000}s`
        : error instanceof Error
          ? error.message
          : String(error);
      if (canRetry) {
        await sleep(retryDelayMs(attempt, null));
        continue;
      }
      throw new Error(`AI API request failed (${settings.baseUrl}): ${reason}`);
    } finally {
      clearTimeout(timer);
    }

    onDebug?.({ stage: 'response', prompt, payload, responseText, status });

    if (status < 200 || status >= 300) {
      if (canRetry && RETRYABLE_STATUSES.has(status)) {
        await sleep(retryDelayMs(attempt, retryAfter));
        continue;
      }
      throw new Error(describeErrorResponse(status, responseText));
    }

    let data: CompletionResponse;
    try {
      data = JSON.parse(responseText) as CompletionResponse;
    } catch {
      throw new Error('AI API returned invalid JSON');
    }

    const content = data.choices?.[0]?.message?.content ?? '';
    if (!content) {
      throw new Error('AI API returned empty content');
    }

    return content;
  }
}

export async function generateCommitMessages({
  settings,
  diff,
  count,
  onDebug,
}: GenerateCommitMessagesInput): Promise<string[]> {
  const systemContent = [
    'You generate git commit messages for staged changes.',
    count === 1
      ? 'Return ONLY a JSON array with exactly 1 string.'
      : `Return ONLY a JSON array of exactly ${count} different strings.`,
    'Each string must be a commit message that matches the instructions.',
    'Each option must summarize the full set of changes in this diff as a single commit.',
    'Do not include any extra commentary or markdown.',
    '',
    'Instructions:',
    formatInstructions(settings),
  ].join('\n');
  const prompt = prepareDiff(diff, settings.ignore);

  const content = await requestCompletion({
    settings,
    systemContent,
    prompt,
    // Room for every option, not just one message
    maxTokens: settings.maxTokens * Math.max(1, count),
    onDebug,
  });

  const jsonMessages = parseJsonArray(content);
  return normalizeMessages(jsonMessages ?? parseLines(content), count);
}

function parseCommitGroups(text: string): CommitGroup[] | null {
  const parsed = parseJsonArrayLoose(text);
  if (!parsed) {
    return null;
  }

  const groups: CommitGroup[] = [];
  for (const item of parsed as Array<{ files?: unknown; message?: unknown }>) {
    if (
      typeof item === 'object' &&
      item !== null &&
      Array.isArray(item.files) &&
      typeof item.message === 'string' &&
      item.message.trim().length > 0
    ) {
      groups.push({
        files: item.files.filter((f: unknown): f is string => typeof f === 'string'),
        message: item.message.trim(),
      });
    }
  }

  return groups.length > 0 ? groups : null;
}

function normalizeModelPath(raw: string): string {
  let value = raw.trim().replace(/^["'`]|["'`]$/g, '');
  if (value.startsWith('./')) {
    value = value.slice(2);
  }
  return value;
}

/**
 * Maps model-returned ids onto the known set: unknown ids are dropped, an id claimed by
 * several groups stays in the first one, empty groups are removed. Ids the model left out
 * are returned separately so the caller can commit them with their own message.
 */
export function reconcileGroups<T extends { message: string }>(
  groups: T[],
  getIds: (group: T) => string[],
  setIds: (group: T, ids: string[]) => T,
  knownIds: string[],
  normalizeId: (id: string) => string[] = (id) => [id],
): { groups: T[]; leftover: string[] } {
  const known = new Set(knownIds);
  const assigned = new Set<string>();
  const result: T[] = [];

  for (const group of groups) {
    const ids: string[] = [];
    for (const raw of getIds(group)) {
      const id = normalizeId(raw).find((candidate) => known.has(candidate));
      if (id && !assigned.has(id)) {
        assigned.add(id);
        ids.push(id);
      }
    }
    if (ids.length > 0) {
      result.push(setIds(group, ids));
    }
  }

  return {
    groups: result,
    leftover: knownIds.filter((id) => !assigned.has(id)),
  };
}

export function reconcileFileGroups(
  groups: CommitGroup[],
  files: string[],
): { groups: CommitGroup[]; leftover: string[] } {
  return reconcileGroups(
    groups,
    (group) => group.files,
    (group, ids) => ({ ...group, files: ids }),
    files,
    (raw) => {
      const value = normalizeModelPath(raw);
      return [value, value.replace(/^[ab]\//, '')];
    },
  );
}

export function reconcileHunkGroups(
  groups: HunkCommitGroup[],
  hunkIds: string[],
): { groups: HunkCommitGroup[]; leftover: string[] } {
  return reconcileGroups(
    groups,
    (group) => group.hunkIds,
    (group, ids) => ({ ...group, hunkIds: ids }),
    hunkIds,
    (raw) => [normalizeModelPath(raw)],
  );
}

export async function generateCommitGroups({
  settings,
  diff,
  files,
  onDebug,
}: GenerateCommitGroupsInput): Promise<CommitGroup[]> {
  const diffText = prepareDiff(diff, settings.ignore);

  const systemContent = [
    'You analyze git diffs and group changed files into logical commits.',
    'Your task is to split the changes into multiple commits, each representing a single logical unit of work.',
    '',
    'Return ONLY a JSON array of objects with this structure:',
    '[{"files": ["file1.ts", "file2.ts"], "message": "commit message"}, ...]',
    '',
    'Rules:',
    '- Use file paths exactly as they appear in the "Changed files" list',
    '- Each file must appear in exactly one group; do not skip any file',
    '- Base each commit message only on the diff of the files in that group',
    '- Group related changes together (e.g., a feature and its tests)',
    '- Each commit message must follow the instructions below',
    '- Order commits logically (e.g., refactoring before new features)',
    '- If all changes belong together, return a single group',
    '- Do not include any extra commentary or markdown',
    '',
    'Commit message instructions:',
    formatInstructions(settings),
  ].join('\n');

  const prompt = [
    'Changed files:',
    files.map((f) => `- ${f}`).join('\n'),
    '',
    'Diff:',
    diffText,
  ].join('\n');

  // Structured output grows with the number of files: leave room so the JSON is not cut off
  const content = await requestCompletion({
    settings,
    systemContent,
    prompt,
    maxTokens: Math.min(
      SPLIT_MAX_TOKENS_CAP,
      Math.max(settings.maxTokens * 3, 1000) + files.length * SPLIT_TOKENS_PER_ITEM,
    ),
    onDebug,
  });

  const groups = parseCommitGroups(content);
  if (!groups || groups.length === 0) {
    throw new Error('Failed to parse commit groups from AI response');
  }

  return groups;
}

function parseHunkGroups(text: string): HunkCommitGroup[] | null {
  const parsed = parseJsonArrayLoose(text);
  if (!parsed) {
    return null;
  }

  const groups: HunkCommitGroup[] = [];
  for (const item of parsed as Array<{ hunkIds?: unknown; message?: unknown }>) {
    if (
      typeof item === 'object' &&
      item !== null &&
      Array.isArray(item.hunkIds) &&
      typeof item.message === 'string' &&
      item.message.trim().length > 0
    ) {
      groups.push({
        hunkIds: item.hunkIds.filter((id: unknown): id is string => typeof id === 'string'),
        message: item.message.trim(),
      });
    }
  }

  return groups.length > 0 ? groups : null;
}

export async function generateCommitGroupsFromHunks({
  settings,
  hunks,
  fullDiff,
  onDebug,
}: GenerateHunkGroupsInput): Promise<HunkCommitGroup[]> {
  const diffText = prepareDiff(fullDiff, settings.ignore);

  const systemContent = [
    'You analyze git diffs and group change hunks into logical commits.',
    'A hunk is a contiguous block of changes within a file. Multiple hunks can exist in one file.',
    'Your task is to split hunks into commits where each commit represents a single logical unit of work.',
    '',
    'Return ONLY a JSON array of objects with this structure:',
    '[{"hunkIds": ["file.ts:1", "file.ts:2"], "message": "commit message"}, ...]',
    '',
    'Rules:',
    '- Use hunk ids exactly as they appear in the "Available hunks" list',
    '- Each hunkId must appear in exactly one group; do not skip any hunk',
    '- Base each commit message only on the hunks in that group',
    '- Group related changes together even if they are in different files',
    '- IMPORTANT: If hunks within the same file are related, keep them in the same commit',
    '- Each commit message must follow the instructions below',
    '- Order commits logically (dependencies first, then dependent changes)',
    '- If all changes belong together, return a single group',
    '- Do not include any extra commentary or markdown',
    '',
    'Commit message instructions:',
    formatInstructions(settings),
  ].join('\n');

  const hunksList = hunks
    .map((h) => `- ${h.id} (${h.file}):\n${h.summary.split('\n').map(l => '    ' + l).join('\n')}`)
    .join('\n');

  const prompt = [
    'Available hunks:',
    hunksList,
    '',
    'Full diff for context:',
    diffText,
  ].join('\n');

  // Structured output grows with the number of hunks: leave room so the JSON is not cut off
  const content = await requestCompletion({
    settings,
    systemContent,
    prompt,
    maxTokens: Math.min(
      SPLIT_MAX_TOKENS_CAP,
      Math.max(settings.maxTokens * 4, 1000) + hunks.length * SPLIT_TOKENS_PER_ITEM,
    ),
    onDebug,
  });

  const groups = parseHunkGroups(content);
  if (!groups || groups.length === 0) {
    throw new Error('Failed to parse hunk groups from AI response');
  }

  return groups;
}
