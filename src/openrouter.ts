import { fetch } from 'undici';

interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

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

function normalizeMessages(messages: string[]): string[] {
  const unique: string[] = [];
  for (const message of messages) {
    if (!unique.includes(message)) {
      unique.push(message);
    }
  }

  if (unique.length < 3) {
    throw new Error('OpenRouter returned fewer than 3 messages');
  }

  return unique.slice(0, 3);
}

export interface GenerateCommitMessagesInput {
  apiKey: string;
  model: string;
  instructions: string;
  diff: string;
  temperature: number;
  maxTokens: number;
  onDebug?: (info: OpenRouterDebugInfo) => void;
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
  apiKey: string;
  model: string;
  instructions: string;
  diff: string;
  files: string[];
  temperature: number;
  maxTokens: number;
  onDebug?: (info: OpenRouterDebugInfo) => void;
}

export interface GenerateHunkGroupsInput {
  apiKey: string;
  model: string;
  instructions: string;
  hunks: HunkInfo[];
  fullDiff: string;
  temperature: number;
  maxTokens: number;
  onDebug?: (info: OpenRouterDebugInfo) => void;
}

export interface OpenRouterDebugInfo {
  stage: 'request' | 'response';
  prompt: string;
  payload: Record<string, unknown>;
  responseText?: string;
  status?: number;
}

interface CompletionRequest {
  apiKey: string;
  model: string;
  systemContent: string;
  prompt: string;
  temperature: number;
  maxTokens: number;
  onDebug?: (info: OpenRouterDebugInfo) => void;
}

/** Sends one chat completion request and returns the text of the first choice. */
async function requestCompletion({
  apiKey,
  model,
  systemContent,
  prompt,
  temperature,
  maxTokens,
  onDebug,
}: CompletionRequest): Promise<string> {
  const payload: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user', content: prompt },
    ],
    temperature,
    max_tokens: maxTokens,
  };

  onDebug?.({ stage: 'request', prompt, payload });

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://aicmt.local',
      'X-Title': 'aicmt',
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  onDebug?.({
    stage: 'response',
    prompt,
    payload,
    responseText,
    status: response.status,
  });

  if (!response.ok) {
    throw new Error(`OpenRouter error: ${response.status} ${responseText}`);
  }

  let data: OpenRouterResponse;
  try {
    data = JSON.parse(responseText) as OpenRouterResponse;
  } catch {
    throw new Error('OpenRouter returned invalid JSON');
  }

  const content = data.choices?.[0]?.message?.content ?? '';
  if (!content) {
    throw new Error('OpenRouter returned empty content');
  }

  return content;
}

export async function generateCommitMessages({
  apiKey,
  model,
  instructions,
  diff,
  temperature,
  maxTokens,
  onDebug,
}: GenerateCommitMessagesInput): Promise<string[]> {
  const trimmedDiff = diff.trim();
  const diffText = trimmedDiff
    ? compressLargeNewFiles(trimmedDiff)
    : '[No diff available]';

  const systemContent = [
    'You generate git commit messages for staged changes.',
    'Return ONLY a JSON array of exactly 3 strings.',
    'Each string must be a commit message that matches the instructions.',
    'Each option must summarize the full set of changes in this diff as a single commit.',
    'Do not include any extra commentary or markdown.',
    '',
    'Instructions:',
    instructions,
  ].join('\n');
  const prompt = diffText;

  const content = await requestCompletion({
    apiKey,
    model,
    systemContent,
    prompt,
    temperature,
    maxTokens,
    onDebug,
  });

  const jsonMessages = parseJsonArray(content);
  if (jsonMessages) {
    return normalizeMessages(jsonMessages);
  }

  const lineMessages = parseLines(content);
  return normalizeMessages(lineMessages);
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
  apiKey,
  model,
  instructions,
  diff,
  files,
  temperature,
  maxTokens,
  onDebug,
}: GenerateCommitGroupsInput): Promise<CommitGroup[]> {
  const trimmedDiff = diff.trim();
  const diffText = trimmedDiff
    ? compressLargeNewFiles(trimmedDiff)
    : '[No diff available]';

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
    instructions,
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
    apiKey,
    model,
    systemContent,
    prompt,
    temperature,
    maxTokens: Math.min(
      SPLIT_MAX_TOKENS_CAP,
      Math.max(maxTokens * 3, 1000) + files.length * SPLIT_TOKENS_PER_ITEM,
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
  apiKey,
  model,
  instructions,
  hunks,
  fullDiff,
  temperature,
  maxTokens,
  onDebug,
}: GenerateHunkGroupsInput): Promise<HunkCommitGroup[]> {
  const trimmedDiff = fullDiff.trim();
  const diffText = trimmedDiff
    ? compressLargeNewFiles(trimmedDiff)
    : '[No diff available]';

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
    instructions,
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
    apiKey,
    model,
    systemContent,
    prompt,
    temperature,
    maxTokens: Math.min(
      SPLIT_MAX_TOKENS_CAP,
      Math.max(maxTokens * 4, 1000) + hunks.length * SPLIT_TOKENS_PER_ITEM,
    ),
    onDebug,
  });

  const groups = parseHunkGroups(content);
  if (!groups || groups.length === 0) {
    throw new Error('Failed to parse hunk groups from AI response');
  }

  return groups;
}
