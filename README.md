# aicmt

AI-assisted git commits via OpenRouter. Designed for fast, consistent commit messages with minimal prompts.

## What it does

- Generates 3 commit message options from the staged diff
- Splits changes into multiple logical commits with `--split`
- Supports global defaults with per-repo overrides
- Can auto-stage and auto-commit with `-y`
- Logs AI request/response with `--verbose` for troubleshooting

## How it works

- Collects staged diff; if unstaged files exist, it can stage all changes
- Builds a minimal prompt: system instructions + raw diff
- Requests 3 commit message options from OpenRouter
- Lets you pick (or auto-picks the first with `-y`)
- Creates the git commit with the chosen message

## Requirements

- Node.js 16+
- Git

## Install

```
npm install -g @lenadweb/aicmt
```

Or run without installing:

```
npx @lenadweb/aicmt
```

## Global config

The global config file lives at:

- `$XDG_CONFIG_HOME/aicmt/config.json`
- `~/.config/aicmt/config.json` (fallback)

Global defaults apply to all repos. Per-repo overrides live under `projects`.

## Init (interactive)

Run init inside a git repo:

```
aicmt init
```

You will choose:

- Commit format (preset or custom)
- Additional instructions
- Model, temperature, max tokens
- Scope (global defaults or repo override)

## Usage

Default command runs `commit` (or `init` if no global config exists yet):

```
aicmt
```

Explicit form:

```
aicmt commit
```

If there are unstaged changes, aicmt will ask to stage them. It always commits all changes that are staged.

## Flags

- `-c, --config <path>`: Custom global config path
- `--dry-run`: Show the chosen message without committing
- `-v, --verbose`: Print AI request and response logs
- `-y, --yes`: Skip prompts (stage all, pick first message, auto-confirm)
- `-s, --split`: Split changes into multiple logical commits (file-level)
- `--split-hunks`: Split changes at hunk level (experimental)

## Split mode

When you have multiple unrelated changes, use `--split` to automatically decompose them into separate commits:

```
aicmt commit --split
```

The AI analyzes your diff and groups files by logical changes:

```
Analyzing 5 changed files...

Proposed 3 commits:

  1. feat: add user authentication
    - src/auth.ts
    - src/middleware/auth.ts

  2. fix: correct validation logic
    - src/validators.ts

  3. docs: update API documentation
    - README.md
    - docs/api.md

Proceed with these 3 commits? (Y/n)
```

Split mode works with other flags:

- `--split --dry-run`: Preview proposed commits without creating them
- `--split -y`: Auto-confirm all commits
- `--split -v`: Show AI request/response for debugging

## Hunk-level split (experimental)

For finer control, use `--split-hunks` to split changes within files:

```
aicmt commit --split-hunks
```

This mode analyzes individual hunks (contiguous blocks of changes) rather than whole files:

```
Analyzing 4 hunks across 2 files...
(experimental hunk-level split mode)

Proposed 2 commits:

  1. fix: correct error handling in auth
    - src/auth.ts:1
    - src/auth.ts:2

  2. feat: add logging middleware
    - src/auth.ts:3
    - src/middleware.ts:1

Proceed with these 2 commits? (Y/n)
```

This is useful when a single file contains multiple unrelated changes. If something goes wrong, the tool will automatically rollback all commits.

**Note:** This is experimental. Use `--dry-run` first to preview the proposed split.

## Config format

Example global config with repo override:

```json
{
  "openrouterApiKey": "sk-...",
  "model": "openai/gpt-4o-mini",
  "format": "conventional",
  "instructions": "Generate a short conventional-lite commit message:\n\nlowercase only\nno period, no emoji\nimperative verb (add / fix / update / remove / improve)\n3-7 words\ndescribe what was done, not why\n\nExamples:\nadd smart preview toggler\nfix expand text for smart preview\nremove custom font family\n\nContext:\n<brief description of code changes>\n\nReturn only one commit message.",
  "temperature": 0.2,
  "maxTokens": 120,
  "projects": {
    "/path/to/repo": {
      "format": "conventional-scope",
      "instructions": "Use Conventional Commits with scope."
    }
  }
}
```

Notes:

- `maxTokens` is clamped between 32 and 512 to prevent excessive output.
- If a repo has no override, global defaults are used.
- Keep the global config private (it contains your API key).

## Troubleshooting

- `No config found for this repo` or `Missing ...`: run `aicmt init` to set global defaults or a repo override.
- `OpenRouter error 400`: your output tokens are too high or diff is too large. Lower `maxTokens` or reduce the staged diff.
- `Not a git repository`: run inside a git repo.

## Local development

```
npm install
npm run build
npm link
```

After linking, the `aicmt` command is available globally.

## Development

```
npm run build
```

Entry point:

- `src/bin/aicmt.ts`
