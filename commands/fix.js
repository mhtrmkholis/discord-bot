import { callAI, extractCode } from "../ai.js"
import { createMR, getFileContent, listFiles } from "../gitlab.js"
import { systemPrompt, analysisPrompt } from "../system-prompt.js"
import { sanitize, safeEdit } from "../utils/discord.js"

export async function handleFix(message) {
  const bugDesc = message.content.replace("!fix", "").trim()

  if (!bugDesc) {
    message.reply("Usage: `!fix describe the bug here`")
    return
  }

  const projectId = process.env.GITLAB_PROJECT_ID

  if (!projectId) {
    message.reply("Missing `GITLAB_PROJECT_ID` in .env")
    return
  }

  const status = await message.reply("🔍 Analyzing bug…")

  try {
    const files = await listFiles(projectId)
    const fileList = files.join("\n")

    await safeEdit(status, "🔍 Identifying affected file…")
    const identifyPrompt = `${analysisPrompt}\n\nFiles in the repository:\n${fileList}\n\nBug description: ${bugDesc}`
    const codePath = (await callAI(identifyPrompt)).replace(/[`"']/g, "").trim()

    if (!codePath || !files.includes(codePath)) {
      await safeEdit(status, `❌ Could not identify the file. AI suggested: \`${sanitize(codePath)}\``)
      return
    }

    await safeEdit(status, `📄 Reading \`${codePath}\`…`)
    const currentCode = await getFileContent(projectId, codePath)

    await safeEdit(status, "🤖 Generating fix…")
    const fixPrompt = `${systemPrompt}\n\nFile: ${codePath}\nCurrent code:\n\`\`\`\n${currentCode}\n\`\`\`\n\nBug description: ${bugDesc}\n\nReturn ONLY the full corrected file.`
    const aiRaw = await callAI(fixPrompt)
    const { code } = extractCode(aiRaw)

    if (!code) {
      await safeEdit(status, "❌ AI returned an empty response.")
      return
    }

    const branchName = `fix/${Date.now()}`
    const mrUrl = await createMR({
      projectId,
      branchName,
      codePath,
      codeContent: code,
      commitMessage: `fix: ${bugDesc.slice(0, 72)}`,
      mrTitle: `AI Fix: ${bugDesc.slice(0, 100)}`,
      onStatus: (s) => safeEdit(status, `⏳ ${s}`).catch(() => {}),
    })

    await safeEdit(status, `✅ MR created for \`${codePath}\`: ${mrUrl}`)
  } catch (err) {
    console.error(err)
    await safeEdit(status, "❌ Pipeline failed — check logs for details.")
  }
}
