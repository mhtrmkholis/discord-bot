import { callAI } from "../ai.js"
import { repoQaPrompt } from "../system-prompt.js"
import { getFileContent, findCandidateFiles } from "../gitlab.js"
import { sanitize, safeEdit, pickKeywords } from "../utils/discord.js"

export async function handleAI(message) {
  const userPrompt = message.content.replace("!ai", "").trim()

  if (!userPrompt) {
    message.reply("Please provide a prompt.")
    return
  }

  const projectId = process.env.GITLAB_PROJECT_ID
  const status = await message.reply("Thinking… 🤖")

  try {
    const keywords = pickKeywords(userPrompt)

    let repoContext = ""

    // Two-phase search: path → content scoring with snippets (works for both local and API)
    const candidates = await findCandidateFiles(keywords, { projectId, maxResults: 10, maxScan: 300, snippetLines: 3 })

    if (candidates.length) {
      const candidateList = candidates
        .map((c) => `${c.path}\n${c.snippets.map((s) => "  " + s).join("\n")}`)
        .join("\n")
      repoContext = "\n\nTop code matches:\n" + candidateList
    }

    // Read up to 4 best-matched files in parallel for deeper context
    const toRead = candidates.slice(0, 4)
    if (toRead.length) {
      const snippets = (await Promise.all(
        toRead.map(async (c) => {
          try {
            const content = await getFileContent(projectId, c.path)
            return `\n### ${c.path}\n\`\`\`\n${content.slice(0, 1200)}\n\`\`\``
          } catch { return null }
        })
      )).filter(Boolean)
      if (snippets.length) {
        repoContext += "\n\nRelevant file contents:" + snippets.join("\n")
      }
    }

    const prompt = `You have access to project context below. Use it to answer the question.\nIf the question asks where something is located, return likely file paths first.${repoContext}\n\nUser question:\n${userPrompt}`
    const aiRaw = await callAI(prompt, repoQaPrompt)
    await safeEdit(status, sanitize(aiRaw))
  } catch (err) {
    console.error(err)
    await safeEdit(status, `❌ ${sanitize(err.message || "Error contacting AI.")}`)
  }
}
