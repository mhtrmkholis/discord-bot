import { callAI } from "../ai.js"
import { repoQaPrompt } from "../system-prompt.js"
import { getFileContent, listFiles, findCandidateFiles } from "../gitlab.js"
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

    if (process.env.LOCAL_REPO_PATH) {
      // Fast two-phase search: path → content scoring with snippets
      const candidates = await findCandidateFiles(keywords, { maxResults: 10, maxScan: 300, snippetLines: 3 })

      if (candidates.length) {
        const candidateList = candidates
          .map((c) => `${c.path}\n${c.snippets.map((s) => "  " + s).join("\n")}`)
          .join("\n")
        repoContext = "\n\nTop code matches from local repo:\n" + candidateList
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
    } else if (projectId) {
      // Fallback: GitLab API file list
      const files = await listFiles(projectId)
      const MAX_FILES = 120
      const shown = files.slice(0, MAX_FILES)
      const matched = files.filter((f) => keywords.some((k) => f.toLowerCase().includes(k))).slice(0, 6)
      const snippets = (await Promise.all(
        matched.map(async (filePath) => {
          try {
            const content = await getFileContent(projectId, filePath)
            return `\n### ${filePath}\n\`\`\`\n${content.slice(0, 1200)}\n\`\`\``
          } catch { return null }
        })
      )).filter(Boolean)
      const fileHeader = files.length > MAX_FILES ? ` (first ${MAX_FILES} of ${files.length})` : ""
      repoContext = `\n\nRepository files${fileHeader}:\n${shown.join("\n")}${snippets.length ? "\n\nRelevant snippets:" + snippets.join("\n") : ""}`
    }

    const prompt = `${repoQaPrompt}\n\nYou have access to project context below. Use it to answer the question.\nIf the question asks where something is located, return likely file paths first.${repoContext}\n\nUser question:\n${userPrompt}`
    const aiRaw = await callAI(prompt)
    await safeEdit(status, sanitize(aiRaw))
  } catch (err) {
    console.error(err)
    await safeEdit(status, `❌ ${sanitize(err.message || "Error contacting AI.")}`)
  }
}
