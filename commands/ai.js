import { callAI, formatCodeReply } from "../ai.js"
import { systemPrompt } from "../system-prompt.js"
import { safeEdit } from "../utils/discord.js"

export async function handleAI(message) {
  const userPrompt = message.content.replace("!ai", "").trim()

  if (!userPrompt) {
    message.reply("Please provide a prompt.")
    return
  }

  const status = await message.reply("Thinking… 🤖")

  try {
    const prompt = `${systemPrompt}\n\nUser request:\n${userPrompt}`
    const aiRaw = await callAI(prompt)
    await safeEdit(status, formatCodeReply(aiRaw))
  } catch (err) {
    console.error(err)
    await safeEdit(status, "Error contacting AI.")
  }
}
