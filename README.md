# aicmt

AI-assisted git commits via OpenRouter or any OpenAI-compatible API (OpenAI, Ollama, LM Studio, ...). Designed for fast, consistent commit messages with minimal prompts.

## What it does

- Generates commit message options from the staged diff (3 by default)
- Lets you pick, regenerate, edit or write your own message
- Works with a plain `git commit` through a git hook (`aicmt hook install`)
- Follows the style of the repository's recent commit messages
- Splits changes into multiple logical commits with `--split`
- Adds prefixes: fixed (`--prefix`) or taken from the branch name (`branchPrefix`)
- Layered config: global defaults, private per-repo override, shared `.aicmtrc.json`, environment variables and CLI flags
- Hides lock files and other noise from the AI (`ignore`)
- Retries on rate limits and server errors, with a request timeout
- `aicmt config` to inspect and change settings, `aicmt doctor` to check the setup

## How it works

- Takes the staged diff (or stages everything with `-a`)
- Builds a prompt: your instructions, recent commit messages as style examples, and the diff with ignored files hidden
- Requests commit message options from the model
- Lets you pick one (or takes the first with `-y`)
- Creates the git commit with the chosen message

## Requirements

- Node.js 18+
- Git

## Install

```
npm install -g @lenadweb/aicmt
```

Or run without installing:

```
npx @lenadweb/aicmt
```

## Configuration

Settings are merged from several layers; later ones win:

1. **Global defaults**: `~/.config/aicmt/config.json` (or `$XDG_CONFIG_HOME/aicmt/config.json`)
2. **Private repo override**: the `projects["/path/to/repo"]` section of the global config
3. **Shared repo config**: `.aicmtrc.json` in the repository root. Commit it to give the whole team the same style. It must not contain an API key.
4. **Environment variables**: `AICMT_API_KEY` (or `OPENROUTER_API_KEY`), `AICMT_MODEL`, `AICMT_BASE_URL`, `AICMT_LANGUAGE`
5. **CLI flags** for a single run

| Key | Description | Default |
| --- | --- | --- |
| `apiKey` | API key (global config or env only) | required for OpenRouter |
| `baseUrl` | OpenAI-compatible API base URL | `https://openrouter.ai/api/v1` |
| `model` | Model id | required |
| `instructions` | How commit messages should look | required |
| `language` | Language of commit messages | not set |
| `count` | Number of message options (1-10) | `3` |
| `temperature` | Sampling temperature (0-2) | `0.2` |
| `maxTokens` | Output tokens per message (32-512) | `120` |
| `timeout` | Request timeout, seconds | `60` |
| `historyExamples` | Recent commit messages sent as style examples (0 to disable) | `10` |
| `ignore` | Extra glob patterns hidden from the AI (added to the built-in list of lock files, `*.min.js`, `*.map`) | `[]` |
| `prefix` | Fixed prefix for every message | not set |
| `branchPrefix` | Prefix taken from the branch name, see below | not set |
| `format` | Name of the format chosen in `init` (informational) | not set |

Ignored files are still committed: only their content is hidden from the AI.

Example `.aicmtrc.json`:

```json
{
  "instructions": "Use Conventional Commits: type(scope): subject. Subject <= 72 chars.",
  "language": "English",
  "ignore": ["generated/**", "*.snap"],
  "branchPrefix": { "pattern": "[A-Z]+-\\d+", "template": "{match}: " }
}
```

### Managing settings

```
aicmt config                          # effective settings and where each comes from
aicmt config get model
aicmt config set model anthropic/claude-sonnet-4.5
aicmt config set language Russian --scope repo      # writes .aicmtrc.json
aicmt config set temperature 0.5 --scope project    # private override for this repo
aicmt config set ignore "generated/**,*.snap" --scope repo
aicmt config unset language --scope repo
aicmt config path
```

Scopes: `global` (default), `project` (private override for this repo), `repo` (`.aicmtrc.json`).

### Check the setup

```
aicmt doctor
```

Checks the git repository, config files, required settings, the branch prefix, API access, the API key and whether the model exists.

### Local and other providers

Any OpenAI-compatible API works. For a local Ollama no API key is needed:

```
aicmt config set baseUrl http://localhost:11434/v1
aicmt config set model llama3.1
```

## Init (interactive)

Run init inside a git repo:

```
aicmt init
```

You will choose:

- Commit format (preset or custom)
- Additional instructions
- Commit message language (optional)
- Model, temperature, max tokens
- Scope: global defaults, private repo override, or shared `.aicmtrc.json`

## Usage

Default command runs `commit` (or `init` if nothing is configured yet):

```
aicmt
```

Explicit form:

```
aicmt commit
```

Only staged changes are committed, like `git commit`. Use `-a` to stage everything first. If nothing is staged, aicmt offers to stage all changes (`-y` does it without asking).

After picking a message you can commit it, edit it (inline for one line, in your git editor for multi-line messages) or go back. `Regenerate` asks the AI for new options.

## Flags

- `-c, --config <path>`: Custom global config path
- `-a, --all`: Stage all changes (including untracked files) before committing
- `-y, --yes`: Skip prompts and take the first message (stages all if nothing is staged)
- `--dry-run`: Show the chosen message without committing
- `-v, --verbose`: Print AI request and response logs
- `-s, --split`: Split changes into multiple logical commits (file-level)
- `--split-hunks`: Split changes at hunk level (experimental)
- `--prefix <string>`: Add a prefix before the commit message (e.g., ticket number)
- `--no-prefix`: Add no prefix at all, ignoring `prefix` and `branchPrefix`
- `--model <id>`: Model for this run
- `--base-url <url>`: API base URL for this run
- `-l, --lang <language>`: Language of commit messages
- `-i, --instructions <text>`: Instructions for this run
- `-t, --temperature <number>`, `--max-tokens <number>`, `-n, --count <number>`, `--timeout <seconds>`

## Git hook

Let a plain `git commit` fill in the message, also from IDEs and git GUIs:

```
aicmt hook install     # in the repository
git add -p
git commit             # the editor opens with a generated message
```

- The hook generates one message from the staged changes and puts it above git's comments, so you can still edit it or abort.
- It does nothing for `git commit -m/-F`, merges, squashes and `--amend`. A `commit.template` without own text (like SourceTree's empty one) is filled in; a template with text is left alone.
- If generation fails, the commit continues as usual with an empty message.
- Skip it once with `AICMT_SKIP_HOOK=1 git commit`.
- `aicmt hook status` and `aicmt hook uninstall` manage it. An existing `prepare-commit-msg` hook from another tool is not overwritten without `--force`.

## Style from history

The last 10 commit messages of the repository (without merges) are sent to the model as style examples, so it follows the project's format, casing and language even with short instructions. Automatic prefixes (`prefix`, `branchPrefix`) are removed from the examples so old ticket ids are not repeated. Change the number with `aicmt config set historyExamples 20`, or turn it off with `0`.

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

The AI sees the full diff of every changed file, including new untracked files. Its answer is checked against the real list of changes: unknown paths are ignored, a file listed twice stays in its first commit, and anything the AI left out goes into a separate commit with its own generated message. If a commit fails midway, all commits made during the split are rolled back and your changes stay in the working tree.

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

## Commit message prefix

Add a prefix (like a ticket number) to all commit messages:

```
aicmt commit --prefix "DEV-95: "
```

The AI generates the commit message, then the prefix is added programmatically:

```
DEV-95: fix: update validation logic
```

This works with all modes:

- `--prefix "JIRA-123: "`: Standard commit with prefix
- `--prefix "TASK-456: " --split`: All split commits get the prefix
- `--prefix "FIX-789: " -y`: Auto-commit with prefix

The prefix is not sent to the AI, it's applied as post-processing to the generated message. If the message already starts with the prefix, it is not added twice.

### Prefix from the branch name

Set `branchPrefix` to take the ticket id from the current branch:

```
aicmt config set branchPrefix "[A-Z]+-\\d+" --scope repo
```

On branch `feature/DEV-95-login` every message gets `DEV-95: `. The optional `template` controls the format: `{match}` is the first capture group (or the whole match), `{1}`, `{2}` are numbered groups. For example `{"pattern": "([A-Z]+-\\d+)", "template": "[{1}] "}` gives `[DEV-95] `.

Priority: `--no-prefix` > `--prefix` > `prefix` setting > `branchPrefix`.

## Config format

Example global config with repo override:

```json
{
  "apiKey": "sk-...",
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
- Keep the global config private (it contains your API key). The old key name `openrouterApiKey` is still read.

## Troubleshooting

- Start with `aicmt doctor`: it shows which step of the setup fails.
- `Missing ...`: run `aicmt init`, or set the value with `aicmt config set` or an environment variable.
- `AI API error 400`: the diff is too large or `maxTokens` is too high. Add noisy files to `ignore`, lower `maxTokens` or commit in smaller parts.
- `request timed out`: raise `timeout` (`--timeout 120`) or use a faster model.
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
