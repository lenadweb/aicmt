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
  stagedFiles: string[];
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
  stagedFiles,
  temperature,
  maxTokens,
  onDebug,
}: GenerateCommitMessagesInput): Promise<string[]> {
  const trimmedDiff = diff.trim();
  const diffText = trimmedDiff
    ? compressLargeNewFiles(trimmedDiff)
    : '[No diff available]';
  const fileList = stagedFiles.length
    ? stagedFiles.map((file) => `- ${file}`).join('\n')
    : '- (no files detected)';

  const prompt = [
    'Return ONLY a JSON array of exactly 3 strings.',
    'Each string must be a commit message that matches the instructions.',
    'Each option must summarize the full set of changes in this diff as a single commit.',
    'Do not include any extra commentary or markdown.',
    '',
    'Instructions:',
    instructions,
    '',
    'Staged files:',
    fileList,
    '',
    'Staged diff:',
    diffText,
  ].join('\n');

  const payload: Record<string, unknown> = {
    model,
    messages: [
      {
        role: 'system',
        content: 'You generate git commit messages for staged changes.',
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
      'HTTP-Referer': 'https://ai-committer.local',
      'X-Title': 'ai-committer',
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
