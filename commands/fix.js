import { callAI, extractCode } from "../ai.js"
import { createMR, getFileContent, listFiles } from "../gitlab.js"
import { systemPrompt, analysisPrompt } from "../system-prompt.js"

export async function handleFix(message) {
  const bugDesc = message.content.replace("!fix", "").trim()

  if (!bugDesc) {
    message.reply("Usage: `!fix describe the bug here`")
    return
  }

  const projectId = process.env.GITLAB_PROJECT_ID

  if (!projectId) {
    message.reply("Missing `GITLAB_PROJECT_ID` in .env — set it to your GitLab project's numeric ID.")
    return
  }

  const status = await message.reply("🔍 Analyzing bug…")

  try {
    // 1. List repo files so the AI knows what exists
    const files = await listFiles(projectId)
    const fileList = files.join("\n")

    // 2. Ask AI which file contains the bug
    await status.edit("🔍 Identifying affected file…")
    const identifyPrompt = `${analysisPrompt}\n\nFiles in the repository:\n${fileList}\n\nBug description: ${bugDesc}`
    const codePath = (await callAI(identifyPrompt)).replace(/[`"']/g, "").trim()

    if (!codePath || !files.includes(codePath)) {
      await status.edit(`❌ Could not identify the file. AI suggested: \`${codePath}\``)
      return
    }

    // 3. Fetch current file content from GitLab
    await status.edit(`📄 Reading \`${codePath}\`…`)
    const currentCode = await getFileContent(projectId, codePath)

    // 4. Ask AI to fix the bug
    await status.edit("🤖 Generating fix…")
    const fixPrompt = `${systemPrompt}\n\nFile: ${codePath}\nCurrent code:\n\`\`\`\n${currentCode}\n\`\`\`\n\nBug description: ${bugDesc}\n\nReturn ONLY the full corrected file.`
    const aiRaw = await callAI(fixPrompt)
    const { code } = extractCode(aiRaw)

    if (!code) {
      await status.edit("❌ AI returned an empty response.")
      return
    }

    // 5. Push to GitLab and create MR
    const branchName = `fix/${Date.now()}`
    const mrUrl = await createMR({
      projectId,
      branchName,
      codePath,
      codeContent: code,
      commitMessage: `fix: ${bugDesc.slice(0, 72)}`,
      mrTitle: `AI Fix: ${bugDesc.slice(0, 100)}`,
      onStatus: (s) => status.edit(`⏳ ${s}`).catch(() => {}),
    })

    await status.edit(`✅ MR created for \`${codePath}\`: ${mrUrl}`)
  } catch (err) {
    console.error(err)
    await status.edit("❌ Pipeline failed — check logs for details.")
  }
}
