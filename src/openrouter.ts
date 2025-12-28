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

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }

  return trimmed.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
}

function parseJsonArray(text: string): string[] | null {
  const cleaned = stripCodeFences(text);
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) {
      return null;
    }

    const strings = parsed
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter(Boolean);

    return strings.length ? strings : null;
  } catch (error) {
    return null;
  }
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

export interface OpenRouterDebugInfo {
  stage: 'request' | 'response';
  prompt: string;
  payload: Record<string, unknown>;
  responseText?: string;
  status?: number;
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

  const payload: Record<string, unknown> = {
    model,
    messages: [
      {
        role: 'system',
        content: systemContent,
      },
      { role: 'user', content: prompt },
    ],
  };

  if (typeof temperature === 'number') {
    payload.temperature = temperature;
  }

  if (typeof maxTokens === 'number') {
    payload.max_tokens = maxTokens;
  }

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
  } catch (error) {
    throw new Error('OpenRouter returned invalid JSON');
  }
  const content = data.choices?.[0]?.message?.content ?? '';

  if (!content) {
    throw new Error('OpenRouter returned empty content');
  }

  const jsonMessages = parseJsonArray(content);
  if (jsonMessages) {
    return normalizeMessages(jsonMessages);
  }

  const lineMessages = parseLines(content);
  return normalizeMessages(lineMessages);
}

function parseCommitGroups(text: string): CommitGroup[] | null {
  const cleaned = stripCodeFences(text);
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) {
      return null;
    }

    const groups: CommitGroup[] = [];
    for (const item of parsed) {
      if (
        typeof item === 'object' &&
        item !== null &&
        Array.isArray(item.files) &&
        typeof item.message === 'string' &&
        item.files.length > 0 &&
        item.message.trim().length > 0
      ) {
        groups.push({
          files: item.files.filter((f: unknown) => typeof f === 'string'),
          message: item.message.trim(),
        });
      }
    }

    return groups.length > 0 ? groups : null;
  } catch (error) {
    return null;
  }
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
    '- Each file should appear in exactly one group',
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

  const payload: Record<string, unknown> = {
    model,
    messages: [
      {
        role: 'system',
        content: systemContent,
      },
      { role: 'user', content: prompt },
    ],
  };

  if (typeof temperature === 'number') {
    payload.temperature = temperature;
  }

  // Use higher max_tokens for split mode since we need structured JSON output
  const splitMaxTokens = Math.max(maxTokens * 3, 500);
  payload.max_tokens = splitMaxTokens;

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
  } catch (error) {
    throw new Error('OpenRouter returned invalid JSON');
  }
  const content = data.choices?.[0]?.message?.content ?? '';

  if (!content) {
    throw new Error('OpenRouter returned empty content');
  }

  const groups = parseCommitGroups(content);
  if (!groups || groups.length === 0) {
    throw new Error('Failed to parse commit groups from AI response');
  }

  // Validate that all files are accounted for
  const groupedFiles = new Set(groups.flatMap((g) => g.files));
  const missingFiles = files.filter((f) => !groupedFiles.has(f));

  if (missingFiles.length > 0) {
    // Add missing files to the last group
    groups[groups.length - 1].files.push(...missingFiles);
  }

  return groups;
}
