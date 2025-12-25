# ai-committer

AI-assisted git commits via OpenRouter.

## Requirements

- Node.js 18+
- Git

## Setup

1. Install dependencies

```
npm install
```

2. Build

```
npm run build
```

3. Initialize config

```
node dist/bin/ai-committer.js init
```

This creates `ai-committer.json` in the repository root and adds it to `.gitignore`.

## Usage

Generate a commit message for staged changes:

```
node dist/bin/ai-committer.js commit
```

If there are no staged changes, you will be asked to stage all changes.
The tool will propose 3 commit messages, then ask for confirmation.
If any unstaged changes exist, the tool requires staging them before generating messages.

### Options

- `--config <path>`: Use a custom config file path.
- `--dry-run`: Show the chosen message without committing.
- `--verbose`: Print AI request and response logs.

## Config format

Example:

```json
{
  "openrouterApiKey": "sk-...",
  "model": "openai/gpt-4o-mini",
  "format": "conventional",
  "instructions": "Write in Russian. Imperative mood. No trailing periods.",
  "temperature": 0.2,
  "maxTokens": 120
}
```

## Notes

- The config contains your API key. Keep it out of version control.
- The tool uses the staged diff to generate commit messages.
