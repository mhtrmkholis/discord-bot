import { getProviderInfo } from "../ai.js"
import { sanitize } from "../utils/discord.js"

export function handleConfig(message) {
  const { provider, model, lightModel, retries, timeout, maxPrompt } = getProviderInfo()
  const repo = process.env.LOCAL_REPO_PATH ? "local" : "remote (GitLab API)"

  message.reply([
    `⚙️ **Bot Configuration**`,
    ``,
    `**Provider:** \`${provider}\``,
    `**Model (fix):** \`${model}\``,
    `**Model (ai):** \`${lightModel}\``,
    `**Repo:** \`${repo}\``,
    ``,
    `**GitLab:** \`${sanitize(process.env.GITLAB_HOST || "—")}\` · Project \`${process.env.GITLAB_PROJECT_ID || "—"}\``,
    `**Local:** \`${sanitize(process.env.LOCAL_REPO_PATH || "—")}\``,
    `**Retries:** \`${retries}\` · **Timeout:** \`${timeout}ms\` · **Max prompt:** \`${maxPrompt}\``,
  ].join("\n"))
}
