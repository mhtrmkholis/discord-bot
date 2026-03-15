# Discord Bot — AI + GitLab Pipeline

A Discord bot that generates AI-powered code fixes and pushes them to GitLab as Merge Requests — all from a single command.

**Created by Kholis** during Ramadhan 2026 in Bandung, Indonesia.

## Features

- `!ai <prompt>` — Ask the AI anything; get a formatted code reply in Discord.
- `!fix <bug description>` — Full pipeline: AI identifies the file → fetches it from GitLab → generates a fix → pushes to a branch → opens a Merge Request → sends the MR link back.
- `!mr <json>` — Manually create a GitLab Merge Request from a JSON payload.

## Project Structure

```
bot.js                ← Entry point (client setup + command routing)
ai.js                 ← AI helpers (callAI, extractCode, formatCodeReply)
gitlab.js             ← GitLab API (createMR)
system-prompt.js      ← System prompt for the AI model
commands/
  ai.js               ← !ai command handler
  fix.js              ← !fix command handler
  mr.js               ← !mr command handler
```

## Requirements

- **Node.js** v18+
- **Ollama** running locally with `qwen2.5-coder:7b` model
- A **Discord bot token** ([Developer Portal](https://discord.com/developers/applications))
- A **GitLab personal access token** with `api` scope

## Setup

1. **Clone & install**

   ```bash
   git clone <your-repo-url>
   cd discord-bot
   npm install
   ```

2. **Configure environment**

   Create a `.env` file:

   ```env
   DISCORD_TOKEN=your_discord_bot_token
   ALLOWED_DISCORD_CHANNEL=your_channel_id
   GITLAB_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx
   GITLAB_PROJECT_ID=12345
   ```

3. **Start Ollama**

   ```bash
   ollama run qwen2.5-coder:7b
   ```

4. **Run the bot**

   ```bash
   node bot.js
   ```

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
3. Fetch that file's current code from GitLab
4. Ask AI to generate the fix
5. Create a branch `fix/<timestamp>`
6. Commit the corrected file
7. Open a Merge Request
8. Reply with the MR link ✅

### Manual Merge Request

```
!mr {"projectId":123,"branchName":"ai-fix-1","codePath":"src/file.js","codeContent":"console.log('fixed')"}
```

## License

ISC
