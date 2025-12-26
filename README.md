# aicmt

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
node dist/bin/aicmt.js init
```

This writes to the global config file:

- `$XDG_CONFIG_HOME/aicmt/config.json`
- `~/.config/aicmt/config.json` (fallback)

Each repository gets its own entry inside the global config.

## Usage

Generate a commit message for staged changes:

```
node dist/bin/aicmt.js commit
```

If there are no staged changes, you will be asked to stage all changes.
The tool will propose 3 commit messages, then ask for confirmation.
If any unstaged changes exist, the tool requires staging them before generating messages.

### Options

- `--config <path>`: Use a custom global config file path.
- `--dry-run`: Show the chosen message without committing.
- `--verbose`: Print AI request and response logs.

## Config format

Example:

```json
{
  "openrouterApiKey": "sk-...",
  "projects": {
    "/path/to/repo": {
      "model": "openai/gpt-4o-mini",
      "format": "conventional",
      "instructions": "Write in Russian. Imperative mood. No trailing periods.",
      "temperature": 0.2,
      "maxTokens": 120
    }
  }
}
```

## Notes

- The global config contains your API key. Keep it private.
- The tool uses the staged diff to generate commit messages.
- `maxTokens` is clamped between 32 and 512 to avoid excessive output.
