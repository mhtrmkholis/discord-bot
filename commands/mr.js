import { createMR } from "../gitlab.js"

export async function handleMR(message) {
  const raw = message.content.replace("!mr", "").trim()
  if (!raw) return message.reply('Usage: `!mr {"projectId":123,"branchName":"fix-1","codePath":"src/file.js","codeContent":"..."}`')

  try {
    const { projectId, branchName, codePath, codeContent } = JSON.parse(raw)
    if (!projectId || !branchName || !codePath || !codeContent) return message.reply("Missing required fields.")
    const url = await createMR({ projectId, branchName, codePath, codeContent })
    message.channel.send(`✅ MR created: ${url}`)
  } catch (err) {
    console.error(err)
    message.reply("Failed to create MR. Check JSON and GITLAB_TOKEN.")
  }
}
