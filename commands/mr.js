import { createMR } from "../gitlab.js"

export async function handleMR(message) {
  const rawPayload = message.content.replace("!mr", "").trim()

  if (!rawPayload) {
    message.reply('Usage: `!mr {"projectId":123,"branchName":"ai-fix-1","codePath":"src/file.js","codeContent":"..."}`')
    return
  }

  try {
    const payload = JSON.parse(rawPayload)
    const { projectId, branchName, codePath, codeContent } = payload

    if (!projectId || !branchName || !codePath || !codeContent) {
      message.reply("Missing required fields: projectId, branchName, codePath, codeContent")
      return
    }

    const mrUrl = await createMR({ projectId, branchName, codePath, codeContent })
    message.channel.send(`✅ MR created: ${mrUrl}`)
  } catch (err) {
    console.error(err)
    message.reply("Failed to create MR. Make sure payload is valid JSON and env GITLAB_TOKEN is set.")
  }
}
