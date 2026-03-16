import { callAI } from "../ai.js"
import { repoQaPrompt } from "../system-prompt.js"
import { getFileContent, getCachedTree, scoreByPath } from "../gitlab.js"
import { sanitize, safeEdit, pickKeywords } from "../utils/discord.js"

export async function handleAI(message) {
  const q = message.content.replace("!ai", "").trim()
  if (!q) return message.reply("Usage: `!ai your question here`")

  const projectId = process.env.GITLAB_PROJECT_ID
  const status = await message.reply("🤖 Thinking…")

  try {
    const keywords = pickKeywords(q)
    const { relPaths } = await getCachedTree(projectId)

    // Fast path-only scoring (no file reads) — instant from cache
    const topPaths = scoreByPath(relPaths, keywords)
      .slice(0, 12)
      .map(({ idx }) => relPaths[idx])

    // Read only top 3 files in parallel for context
    const snippets = (await Promise.all(
      topPaths.slice(0, 3).map(async (p) => {
        try {
          const c = await getFileContent(projectId, p)
          return `### ${p}\n\`\`\`\n${c.slice(0, 1200)}\n\`\`\``
        } catch { return null }
      })
    )).filter(Boolean)

    const context = topPaths.length
      ? `\n\nMatching files:\n${topPaths.join("\n")}${snippets.length ? "\n\n" + snippets.join("\n\n") : ""}`
      : ""

    const aiRaw = await callAI(
      `Answer based on the project context below.${context}\n\nQuestion: ${q}`,
      repoQaPrompt,
      { light: true },
    )
    await safeEdit(status, sanitize(aiRaw))
  } catch (err) {
    console.error(err)
    await safeEdit(status, `❌ ${sanitize(err.message || "AI error")}`)
  }
}
