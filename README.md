# aicmt

AI-assisted git commits via OpenRouter. Designed for fast, consistent commit messages with minimal prompts.

## What it does

- Generates 3 commit message options from the staged diff
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
