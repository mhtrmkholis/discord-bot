# Discord Bot — AI + GitLab Pipeline

A Discord bot that generates AI-powered code fixes and pushes them to GitLab as
Merge Requests — all from a single command.

**Created by Kholis** during Ramadhan 2026 in Bandung, Indonesia.

---

## Features

| Command                  | Description                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `!ai <prompt>`           | Ask the AI anything — replies with a formatted code block.                                          |
| `!fix <bug description>` | Full pipeline: identify file → fetch from GitLab → AI fix → branch → commit → MR → reply with link. |
| `!mr <json>`             | Manually create a GitLab Merge Request from a JSON payload.                                         |

## Project Structure

```
bot.js                 ← Entry point (client + command routing)
ai.js                  ← AI providers (Copilot CLI / Ollama)
gitlab.js              ← GitLab API (files, branches, MRs)
system-prompt.js       ← System + analysis prompts
utils/
  discord.js           ← Safe message editing helper
commands/
  ai.js                ← !ai handler
  fix.js               ← !fix handler
  mr.js                ← !mr handler
```

## Requirements

- **Node.js** ≥ 18
- **Discord bot token** — [Developer Portal](https://discord.com/developers/applications)
- **GitLab personal access token** with `api` scope
- **AI provider** (pick one):
  - [GitHub Copilot CLI](https://gh.io/copilot-cli) (default — cloud)
  - [Ollama](https://ollama.com) (fully local)

## Quick Start

```bash
git clone https://github.com/mhtrmkholis/discord-bot.git
cd discord-bot
npm install
cp .env.example .env   # then fill in your tokens
npm start
```

## Environment Variables

Copy `.env.example` → `.env` and fill in:

| Variable                  | Required | Description                                      |
| ------------------------- | -------- | ------------------------------------------------ |
| `DISCORD_TOKEN`           | yes      | Bot token from Discord Developer Portal          |
| `ALLOWED_DISCORD_CHANNEL` | yes      | Channel ID the bot listens in                    |
| `GITLAB_HOST`             | yes      | GitLab instance URL (e.g. `https://gitlab.com`)  |
| `GITLAB_TOKEN`            | yes      | Personal access token with `api` scope           |
| `GITLAB_PROJECT_ID`       | yes      | Numeric project ID (Settings → General)          |
| `AI_PROVIDER`             | no       | `copilot` (default) or `ollama`                  |
| `GH_PATH`                 | no       | Absolute path to `gh` binary                     |
| `GH_TOKEN`                | no       | GitHub token for Copilot auth                    |
| `COPILOT_MODEL`           | no       | Model name (see list in `.env.example`)          |
| `OLLAMA_MODEL`            | no       | Ollama model name (default: `qwen2.5-coder:14b`) |

## Usage

### Ask AI

```
!ai write a function that reverses a string in python
```

### Auto-fix + Merge Request

```
!fix the parseDate function crashes on empty strings
```

The bot will:

1. List all files in the GitLab repo
2. Ask AI which file contains the bug
3. Fetch the file's current code from GitLab
4. Generate the fix
5. Create branch `fix/<timestamp>`
6. Commit the corrected file
7. Open a Merge Request
8. Reply with the MR link ✅

### Manual Merge Request

```
!mr {"projectId":123,"branchName":"fix-1","codePath":"src/file.js","codeContent":"..."}
```

## Notes

- `AI_PROVIDER=copilot` — model runs in the cloud via GitHub Copilot CLI.
- `AI_PROVIDER=ollama` — model runs locally on your machine.
- Switch models anytime by changing `COPILOT_MODEL` or `OLLAMA_MODEL` in `.env`.

## License

ISC
