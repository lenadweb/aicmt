# Changelog

## 1.0.1 — 2026-09-30

### Changed

- **Node.js 18 or newer is now required** (Node 16 is end-of-life). The `undici` dependency is gone: the built-in `fetch` is used.

### New

- **Git hook**: `aicmt hook install` adds a `prepare-commit-msg` hook, so a plain `git commit` (also from IDEs and git GUIs) opens the editor with a generated message. Works with an empty `commit.template`; skipped for `-m`, merges, squashes and `--amend`, or with `AICMT_SKIP_HOOK=1`.
- **Style from history**: the latest commit messages of the repository (`historyExamples`, 10 by default) are sent to the model as style examples. Automatic prefixes are stripped from them.

## 1.0.0 — 2026-09-30

### Breaking changes

- **Only staged changes are committed by default**, like `git commit`. Use `-a` / `--all` to stage everything first. When nothing is staged, aicmt offers to stage all changes (`-y` does it without asking).
- **`-y` no longer stages unstaged changes when something is already staged.** It commits the index as it is.
- **`-y` asks the model for a single message** instead of three, since only the first one is used.
- **The config key `openrouterApiKey` is now `apiKey`.** The old name is still read; `aicmt config set apiKey` and `aicmt init` write the new one.
- **`format` is no longer required** in the config. It only records which preset `init` used.

### New

- **Message editing**: after choosing a message you can commit, edit it (inline, or in your git editor for multi-line messages) or go back. `Regenerate` asks for new options.
- **Layered configuration**: global defaults → private per-repo override → shared `.aicmtrc.json` in the repository → environment variables → CLI flags.
- **Environment variables**: `AICMT_API_KEY` / `OPENROUTER_API_KEY`, `AICMT_MODEL`, `AICMT_BASE_URL`, `AICMT_LANGUAGE`.
- **Any OpenAI-compatible API** via `baseUrl` (OpenAI, Ollama, LM Studio, ...). No API key is needed for local servers.
- **New settings**: `language`, `count`, `timeout`, `ignore`, `prefix`, `branchPrefix`.
- **New flags**: `-a/--all`, `--no-prefix`, `--base-url`, `-l/--lang`, `-i/--instructions`, `-t/--temperature`, `--max-tokens`, `-n/--count`, `--timeout`.
- **Prefix from the branch name**: `branchPrefix` turns `feature/DEV-95-login` into `DEV-95: `.
- **`ignore`**: lock files, `*.min.js` and `*.map` are hidden from the model by default; add your own glob patterns. Ignored files are still committed.
- **`aicmt config`** (`list`, `get`, `set`, `unset`, `path`) shows each effective value and where it comes from.
- **`aicmt doctor`** checks the repository, config files, API access, API key and model.
- **`init`** asks for the message language and can write a shared `.aicmtrc.json`.

### Fixes and improvements

- **Split modes assign changes to the right commits**: new untracked files are part of the diff the model sees, the model's answer is checked against the real list of changes, and anything it skipped gets its own commit with its own message.
- **File-level split rolls back** all created commits if one of them fails.
- **Paths with spaces or non-ASCII characters** work in every mode.
- **Hunk split** handles binary, mode-only and empty files.
- **Requests time out** (60 s by default) and are retried on rate limits and server errors; API errors are shown as readable messages.
- **A spinner** is shown while waiting for the model.
- **Fewer options than requested** from the model is no longer an error.
- **The published package is always rebuilt** before `npm publish`, so `--version` matches `package.json`.
