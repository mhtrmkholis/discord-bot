import { getLightModelName } from "../ai.js"
import { sanitize } from "../utils/discord.js"

export async function handleConfig(message) {
  const provider = (process.env.AI_PROVIDER || "copilot").toLowerCase()
  const model = provider === "ollama"
    ? (process.env.OLLAMA_MODEL || "qwen2.5-coder:14b")
    : (process.env.COPILOT_MODEL || "(default)")
  const lightModel = getLightModelName()
  const repo = process.env.LOCAL_REPO_PATH ? "local" : "remote (GitLab API)"
  const localPath = process.env.LOCAL_REPO_PATH || "—"
  const gitlabHost = process.env.GITLAB_HOST || "—"
  const projectId = process.env.GITLAB_PROJECT_ID || "—"
  const retries = process.env.COPILOT_RETRIES || "2"
  const timeout = process.env.COPILOT_TIMEOUT_MS || "120000"
  const maxPrompt = process.env.COPILOT_MAX_PROMPT_CHARS || "50000"

  const lines = [
    `⚙️ **Bot Configuration**`,
    ``,
    `**AI Provider:** \`${provider}\``,
    `**Model (fix):** \`${model}\``,
    `**Model (ai/config):** \`${lightModel}\``,
    `**Repo Mode:** \`${repo}\``,
    ``,
    `**GitLab Host:** \`${sanitize(gitlabHost)}\``,
    `**Project ID:** \`${projectId}\``,
    `**Local Repo:** \`${sanitize(localPath)}\``,
    ``,
    `**Copilot Retries:** \`${retries}\``,
    `**Copilot Timeout:** \`${timeout}ms\``,
    `**Max Prompt Chars:** \`${maxPrompt}\``,
  ]

  message.reply(lines.join("\n"))
}
